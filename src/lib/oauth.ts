import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { asStringArray, type Queryable } from "./db";
import { domainAllowed, type AppEnv } from "./env";
import { hashToken } from "./campaigns";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;

export type GoogleProfile = {
  email: string;
  email_verified?: boolean;
  hd?: string;
};

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function redirectsMatch(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const left = new URL(registered);
    const right = new URL(requested);
    if (left.protocol !== right.protocol) return false;
    if (left.hostname !== right.hostname) return false;
    if (left.pathname.replace(/\/$/, "") !== right.pathname.replace(/\/$/, "")) return false;
    if (loopback(left.hostname) && loopback(right.hostname)) return true;
    return left.port === right.port;
  } catch {
    return false;
  }
}

export function redirectAllowed(uri: string): boolean {
  if (
    uri === "https://claude.ai/api/mcp/auth_callback" ||
    uri === "https://claude.com/api/mcp/auth_callback"
  ) {
    return true;
  }
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:") return false;
    if (!loopback(url.hostname)) return false;
    return url.pathname === "/callback" || url.pathname === "/callback/";
  } catch {
    return false;
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function registerClient(
  db: Queryable,
  body: {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
    grant_types?: string[];
    response_types?: string[];
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const redirects = body.redirect_uris ?? [];
  if (!redirects.length || redirects.some((uri) => !redirectAllowed(uri))) {
    return {
      status: 400,
      body: {
        error: "invalid_redirect_uri",
        error_description: "Redirect URIs must be the Claude callback or a loopback /callback.",
      },
    };
  }
  const clientId = randomId("tce_client");
  await db.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [
      clientId,
      body.client_name ?? "Claude",
      JSON.stringify(redirects),
      body.token_endpoint_auth_method ?? "none",
    ],
  );
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_name: body.client_name ?? "Claude",
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_secret_expires_at: 0,
    },
  };
}

async function clientAllows(db: Queryable, clientId: string, redirectUri: string, fetchImpl: typeof fetch): Promise<boolean> {
  const rows = await db.query<{ redirect_uris: unknown }>(
    `SELECT redirect_uris FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  if (rows[0]) {
    return asStringArray(rows[0].redirect_uris).some((uri) => redirectsMatch(uri, redirectUri));
  }
  if (!clientId.startsWith("https://")) return false;
  let document: { client_id?: string; redirect_uris?: string[] };
  try {
    const response = await fetchImpl(clientId, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    document = (await response.json()) as { client_id?: string; redirect_uris?: string[] };
  } catch {
    return false;
  }
  if (document.client_id && document.client_id !== clientId) return false;
  const redirects = document.redirect_uris ?? [];
  if (!redirects.some((uri) => redirectsMatch(uri, redirectUri) && redirectAllowed(redirectUri))) return false;
  await db.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, $2, $3::jsonb, 'none')
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, "Claude CIMD", JSON.stringify(redirects)],
  );
  return true;
}

export async function beginAuthorization(
  db: Queryable,
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; txn: string } | { ok: false; status: number; error: string; description: string }> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "";
  const responseType = params.get("response_type") ?? "";
  if (responseType !== "code") {
    return { ok: false, status: 400, error: "unsupported_response_type", description: "Only code is supported." };
  }
  if (method !== "S256" || challenge.length < 20) {
    return { ok: false, status: 400, error: "invalid_request", description: "PKCE S256 code_challenge is required." };
  }
  if (!redirectAllowed(redirectUri)) {
    return { ok: false, status: 400, error: "invalid_redirect_uri", description: "Redirect URI is not allowed." };
  }
  if (!(await clientAllows(db, clientId, redirectUri, fetchImpl))) {
    return { ok: false, status: 400, error: "invalid_client", description: "Unknown client or redirect URI." };
  }
  const txn = randomId("txn");
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO oauth_transactions
      (id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, client_state, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      txn,
      clientId,
      redirectUri,
      challenge,
      method,
      params.get("scope") ?? "campaigns",
      params.get("resource"),
      params.get("state"),
      expires,
    ],
  );
  return { ok: true, txn };
}

export async function googleRedirect(env: AppEnv, txn: string, baseUrl: string): Promise<string> {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", `${baseUrl}/api/oauth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", txn);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleCode(
  env: AppEnv,
  code: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleProfile> {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new Error("Google OAuth is not configured.");
  }
  const body = new URLSearchParams({
    code,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    redirect_uri: `${baseUrl}/api/oauth/google/callback`,
    grant_type: "authorization_code",
  });
  const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok) throw new Error("Google token exchange failed.");
  const tokenJson = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("Google did not return an access token.");
  const profileResponse = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileResponse.ok) throw new Error("Google userinfo failed.");
  const profile = (await profileResponse.json()) as GoogleProfile;
  if (!profile.email) throw new Error("Google did not return an email.");
  return profile;
}

export function profileAllowed(profile: GoogleProfile, domains: string[]): string | null {
  const email = profile.email.trim().toLowerCase();
  if (profile.email_verified === false) return null;
  if (!domainAllowed(email, domains)) return null;
  if (profile.hd && !domains.includes(profile.hd.trim().toLowerCase())) return null;
  return email;
}

const MICROSOFT_SCOPE = "openid profile email User.Read";

export function microsoftAuthorizeUrl(env: AppEnv, txn: string, nonce: string, baseUrl: string): string {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(env.azureTenantId)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", env.azureClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${baseUrl}/api/oauth/microsoft/callback`);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPE);
  url.searchParams.set("state", txn);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function rememberProviderNonce(db: Queryable, txnId: string): Promise<string | null> {
  const nonce = randomBytes(24).toString("base64url");
  const rows = await db.query<{ id: string }>(
    `UPDATE oauth_transactions SET provider_nonce = $2 WHERE id = $1 AND expires_at > now() RETURNING id`,
    [txnId, nonce],
  );
  return rows[0] ? nonce : null;
}

export async function readProviderNonce(db: Queryable, txnId: string): Promise<string | null> {
  const rows = await db.query<{ provider_nonce: string | null }>(
    `SELECT provider_nonce FROM oauth_transactions WHERE id = $1 AND expires_at > now()`,
    [txnId],
  );
  return rows[0]?.provider_nonce ?? null;
}

export type MicrosoftIdentity =
  | { ok: true; email: string }
  | { ok: false; reason: "not_configured" | "token_exchange" | "invalid_id_token" | "domain" };

type JwtHeader = { alg?: string; kid?: string };
type JsonWebKeyWithKid = JsonWebKey & { kid?: string };

const jwksCache = new Map<string, { expires: number; keys: JsonWebKeyWithKid[] }>();

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

export function emailFromIdTokenClaims(payload: Record<string, unknown>): string | null {
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const preferred = typeof payload.preferred_username === "string" ? payload.preferred_username.trim() : "";
  const chosen = email.includes("@") ? email : preferred;
  if (!chosen.includes("@")) return null;
  return chosen.toLowerCase();
}

function rsaJwk(key: JsonWebKeyWithKid): JsonWebKey | null {
  if (key.kty !== "RSA" || !key.n || !key.e) return null;
  return { kty: "RSA", n: key.n, e: key.e, alg: "RS256", use: "sig" };
}

async function microsoftKeys(tenantId: string, fetchImpl: typeof fetch): Promise<JsonWebKeyWithKid[]> {
  if (fetchImpl === fetch) {
    const cached = jwksCache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.keys;
  }
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`,
  );
  if (!response.ok) throw new Error("Microsoft signing keys could not be loaded.");
  const body = (await response.json()) as { keys?: JsonWebKeyWithKid[] };
  const keys = body.keys ?? [];
  if (fetchImpl === fetch) jwksCache.set(tenantId, { expires: Date.now() + 60 * 60 * 1000, keys });
  return keys;
}

async function verifyRs256(signingInput: string, signature: string, jwk: JsonWebKey): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = new Uint8Array(Buffer.from(signature, "base64url"));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(signingInput));
}

export async function exchangeMicrosoftCode(
  env: AppEnv,
  code: string,
  baseUrl: string,
  expectedNonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftIdentity> {
  if (!env.azureTenantId || !env.azureClientId || !env.azureClientSecret) {
    return { ok: false, reason: "not_configured" };
  }
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(env.azureTenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    code,
    client_id: env.azureClientId,
    client_secret: env.azureClientSecret,
    redirect_uri: `${baseUrl}/api/oauth/microsoft/callback`,
    grant_type: "authorization_code",
    scope: MICROSOFT_SCOPE,
  });
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return { ok: false, reason: "token_exchange" };
  }
  if (!tokenResponse.ok) return { ok: false, reason: "token_exchange" };
  const tokenJson = (await tokenResponse.json()) as { id_token?: string };
  const idToken = tokenJson.id_token ?? "";
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid_id_token" };
  let header: JwtHeader;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonSegment(parts[0]!) as JwtHeader;
    payload = decodeJsonSegment(parts[1]!) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "invalid_id_token" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "invalid_id_token" };
  let keys: JsonWebKeyWithKid[];
  try {
    keys = await microsoftKeys(env.azureTenantId, fetchImpl);
  } catch {
    return { ok: false, reason: "invalid_id_token" };
  }
  const candidates = keys.filter((key) => !header.kid || key.kid === header.kid);
  const signingInput = `${parts[0]}.${parts[1]}`;
  let verified = false;
  for (const key of candidates) {
    const jwk = rsaJwk(key);
    if (!jwk) continue;
    try {
      if (await verifyRs256(signingInput, parts[2]!, jwk)) {
        verified = true;
        break;
      }
    } catch {
      verified = false;
    }
  }
  if (!verified) return { ok: false, reason: "invalid_id_token" };

  const tenant = env.azureTenantId.toLowerCase();
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const audience = payload.aud;
  const audienceOk = audience === env.azureClientId || (Array.isArray(audience) && audience.includes(env.azureClientId));
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;
  const now = Math.floor(Date.now() / 1000);
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const tid = typeof payload.tid === "string" ? payload.tid.toLowerCase() : "";
  if (
    String(payload.iss ?? "").toLowerCase() !== issuer ||
    !audienceOk ||
    tid !== tenant ||
    !nonce ||
    !same(nonce, expectedNonce) ||
    exp < now - 60 ||
    (nbf && nbf > now + 60)
  ) {
    return { ok: false, reason: "invalid_id_token" };
  }
  const email = emailFromIdTokenClaims(payload);
  if (!email || !domainAllowed(email, env.allowedDomains)) return { ok: false, reason: "domain" };
  return { ok: true, email };
}

export async function issueCodeForTransaction(
  db: Queryable,
  txnId: string,
  email: string,
): Promise<{ redirect: string } | { error: string }> {
  const rows = await db.query<{
    id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string | null;
    resource: string | null;
    client_state: string | null;
    expires_at: unknown;
  }>(`SELECT * FROM oauth_transactions WHERE id = $1`, [txnId]);
  const txn = rows[0];
  if (!txn) return { error: "This sign-in session expired. Start again from Claude." };
  const expiresAt = new Date(String(txn.expires_at));
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return { error: "This sign-in session expired. Start again from Claude." };
  }
  const provisioned = await db.query(`SELECT email FROM rep_configs WHERE lower(email) = lower($1)`, [email]);
  if (!provisioned[0]) {
    return { error: `${email} is not on the rep mailbox map. Ask an admin to add you before connecting Claude.` };
  }
  const code = randomId("code");
  await db.query(
    `INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, rep_email, resource, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      hashToken(code),
      txn.client_id,
      txn.redirect_uri,
      txn.code_challenge,
      txn.code_challenge_method,
      email,
      txn.resource,
      txn.scope,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    ],
  );
  await db.query(`DELETE FROM oauth_transactions WHERE id = $1`, [txnId]);
  const target = new URL(txn.redirect_uri);
  target.searchParams.set("code", code);
  if (txn.client_state) target.searchParams.set("state", txn.client_state);
  return { redirect: target.toString() };
}

type TokenRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  rep_email: string;
  resource: string | null;
  scope: string | null;
  expires_at: unknown;
  used_at: unknown;
};

async function storeTokens(
  db: Queryable,
  input: { clientId: string; email: string; scope: string | null; resource: string | null },
): Promise<Record<string, unknown>> {
  const access = randomId("tce_at");
  const refresh = randomId("tce_rt");
  const now = Date.now();
  await db.query(
    `INSERT INTO oauth_tokens
      (access_hash, refresh_hash, client_id, rep_email, scope, resource, expires_at, refresh_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      hashToken(access),
      hashToken(refresh),
      input.clientId,
      input.email,
      input.scope ?? "campaigns",
      input.resource,
      new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString(),
      new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString(),
    ],
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: input.scope ?? "campaigns",
  };
}

export async function tokenRequest(db: Queryable, form: URLSearchParams): Promise<{ status: number; body: Record<string, unknown> }> {
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";
    const rows = await db.query<TokenRow>(`SELECT * FROM oauth_codes WHERE code_hash = $1`, [hashToken(code)]);
    const row = rows[0];
    if (!row || row.used_at) return { status: 400, body: { error: "invalid_grant" } };
    const expires = new Date(String(row.expires_at));
    if (expires.getTime() < Date.now()) return { status: 400, body: { error: "invalid_grant" } };
    if (row.client_id !== clientId || !redirectsMatch(row.redirect_uri, redirectUri)) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    if (!verifier || !same(pkce(verifier), row.code_challenge)) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    await db.query(`UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1`, [hashToken(code)]);
    const body = await storeTokens(db, {
      clientId: row.client_id,
      email: row.rep_email,
      scope: row.scope,
      resource: row.resource,
    });
    return { status: 200, body };
  }
  if (grant === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    const rows = await db.query<{
      client_id: string;
      rep_email: string;
      scope: string | null;
      resource: string | null;
      refresh_expires_at: unknown;
      revoked_at: unknown;
    }>(
      `SELECT client_id, rep_email, scope, resource, refresh_expires_at, revoked_at
       FROM oauth_tokens WHERE refresh_hash = $1`,
      [hashToken(refresh)],
    );
    const row = rows[0];
    if (!row || row.revoked_at) return { status: 400, body: { error: "invalid_grant" } };
    if (new Date(String(row.refresh_expires_at)).getTime() < Date.now()) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    await db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE refresh_hash = $1`, [hashToken(refresh)]);
    const body = await storeTokens(db, {
      clientId: row.client_id,
      email: row.rep_email,
      scope: row.scope,
      resource: row.resource,
    });
    return { status: 200, body };
  }
  return { status: 400, body: { error: "unsupported_grant_type" } };
}

export async function verifyBearer(db: Queryable, token: string | undefined): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  const hash = hashToken(token);
  const repRows = await db.query<{ rep_email: string; id: string }>(
    `SELECT id, rep_email FROM rep_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  if (repRows[0]) {
    return {
      token,
      clientId: `rep:${repRows[0].id}`,
      scopes: ["campaigns"],
      extra: { email: repRows[0].rep_email, via: "rep_token" },
    };
  }
  const oauthRows = await db.query<{
    client_id: string;
    rep_email: string;
    scope: string | null;
    expires_at: unknown;
  }>(
    `SELECT client_id, rep_email, scope, expires_at FROM oauth_tokens
     WHERE access_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  const oauth = oauthRows[0];
  if (!oauth) return undefined;
  const expires = new Date(String(oauth.expires_at));
  if (expires.getTime() <= Date.now()) return undefined;
  return {
    token,
    clientId: oauth.client_id,
    scopes: (oauth.scope ?? "campaigns").split(" ").filter(Boolean),
    expiresAt: Math.floor(expires.getTime() / 1000),
    extra: { email: oauth.rep_email, via: "oauth" },
  };
}

export function authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    registration_endpoint: `${baseUrl}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
    scopes_supported: ["campaigns", "offline_access"],
  };
}

export function protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
  return {
    resource: `${baseUrl}/api/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["campaigns"],
    resource_name: "TCE EmailBison campaigns",
  };
}

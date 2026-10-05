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
      token_endpoint_auth_methods_supported: undefined,
      token_endpoint_auth_method: "none",
      client_secret_expires_at: 0,
    },
  };
}

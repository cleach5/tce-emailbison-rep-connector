import { WORKSPACE_ID } from "./constants";

export type Queryable = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
};

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS rep_configs (
    email TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    sender_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    owner_tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS rep_tokens (
    id TEXT PRIMARY KEY,
    rep_email TEXT NOT NULL REFERENCES rep_configs(email),
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris JSONB NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    client_secret_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_transactions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    scope TEXT,
    resource TEXT,
    client_state TEXT,
    provider_nonce TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE oauth_transactions ADD COLUMN IF NOT EXISTS provider_nonce TEXT`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    rep_email TEXT NOT NULL,
    resource TEXT,
    scope TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    access_hash TEXT PRIMARY KEY,
    refresh_hash TEXT UNIQUE,
    client_id TEXT NOT NULL,
    rep_email TEXT NOT NULL,
    scope TEXT,
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS campaigns (
    bison_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    audience TEXT NOT NULL CHECK (audience IN ('personal', 'corporate')),
    owner_email TEXT NOT NULL REFERENCES rep_configs(email),
    do_not_mention JSONB NOT NULL,
    sequence_id INTEGER,
    max_emails_per_day INTEGER,
    max_new_leads_per_day INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS activation_requests (
    id TEXT PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    rep_email TEXT NOT NULL,
    status TEXT NOT NULL,
    preflight JSONB NOT NULL,
    lead_counts JSONB NOT NULL,
    senders JSONB NOT NULL,
    caps JSONB NOT NULL,
    first_touch JSONB NOT NULL,
    deny_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS surbl_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    synced_at TIMESTAMPTZ,
    domains JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO surbl_sync (id, domains) VALUES (1, '[]'::jsonb) ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS domain_first_seen (
    domain TEXT PRIMARY KEY,
    first_seen TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    rep_email TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_summary JSONB NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS activations_status_idx ON activation_requests (status, created_at DESC)`,
];

export async function migrate(db: Queryable): Promise<void> {
  for (const statement of SCHEMA) {
    await db.query(statement);
  }
}

type PgliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};

async function fromPglite(dataDir?: string): Promise<Queryable> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg: PgliteLike = dataDir ? new PGlite(dataDir) : new PGlite();
  const db: Queryable = {
    async query<T>(text: string, params: unknown[] = []) {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

async function fromNeon(url: string): Promise<Queryable> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  const db: Queryable = {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await sql.query(text, params);
      return rows as T[];
    },
    async close() {},
  };
  await migrate(db);
  return db;
}

export async function createQueryable(databaseUrl?: string): Promise<Queryable> {
  if (!databaseUrl || databaseUrl === "memory" || databaseUrl.startsWith("pglite")) {
    const dir = databaseUrl?.startsWith("pglite:")
      ? databaseUrl.slice("pglite:".length)
      : undefined;
    return fromPglite(dir || undefined);
  }
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    return fromNeon(databaseUrl);
  }
  throw new Error(
    "DATABASE_URL must be a postgres connection string or pglite:<directory>.",
  );
}

const globalDb = globalThis as unknown as { __tceDb?: Promise<Queryable> };

export function getDb(): Promise<Queryable> {
  if (!globalDb.__tceDb) {
    const url = process.env.DATABASE_URL;
    const local = url && url.length > 0 ? url : "pglite:.data/pglite";
    globalDb.__tceDb = createQueryable(local);
  }
  return globalDb.__tceDb;
}

export function resetDbForTests(): void {
  globalDb.__tceDb = undefined;
}

export function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function asNumberArray(value: unknown): number[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => Number(item)).filter((item) => Number.isInteger(item));
}

export function asStringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item));
}

export const REQUIRED_WORKSPACE_ID = WORKSPACE_ID;

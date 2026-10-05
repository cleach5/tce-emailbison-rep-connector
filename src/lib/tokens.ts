import { randomBytes } from "node:crypto";
import { hashToken } from "./campaigns";
import type { Queryable } from "./db";

export async function createRepToken(db: Queryable, email: string, label: string) {
  const token = `tce_${randomBytes(32).toString("base64url")}`;
  const id = `tok_${randomBytes(8).toString("hex")}`;
  await db.query(
    `INSERT INTO rep_tokens (id, rep_email, token_hash, token_hint, label) VALUES ($1, $2, $3, $4, $5)`,
    [id, email, hashToken(token), token.slice(-4), label],
  );
  return { id, token, label };
}

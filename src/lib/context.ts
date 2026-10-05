import { BisonClient } from "./bison";
import type { AppCtx } from "./campaigns";
import { getDb } from "./db";
import { readEnv } from "./env";
import { timingSafeEqual } from "node:crypto";

export async function makeCtx(actor: "rep" | "admin"): Promise<AppCtx> {
  const env = readEnv();
  const db = await getDb();
  return {
    db,
    bison: new BisonClient({
      baseUrl: env.bisonBaseUrl,
      apiKey: env.bisonApiKey,
      actor,
    }),
    now: () => new Date(),
    webhookUrl: env.activationWebhookUrl || undefined,
  };
}

export function adminAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN ?? "";
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (!expected || !token) return false;
  const left = Buffer.from(token);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

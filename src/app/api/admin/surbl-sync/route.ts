import { recordSurblSync } from "@/lib/campaigns";
import { adminAuthorized, json, makeCtx } from "@/lib/context";
import { asDate } from "@/lib/surbl";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const ctx = await makeCtx("admin");
  const rows = await ctx.db.query<{ synced_at: unknown; domains: unknown }>(
    `SELECT synced_at, domains FROM surbl_sync WHERE id = 1`,
  );
  return json({
    ok: true,
    synced_at: asDate(rows[0]?.synced_at)?.toISOString() ?? null,
    domains: rows[0]?.domains ?? [],
  });
}

export async function POST(req: Request) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = (await req.json()) as { synced_at?: string; domains?: string[] };
  const ctx = await makeCtx("admin");
  const result = await recordSurblSync(ctx, body);
  return json(result, result.ok ? 200 : 400);
}

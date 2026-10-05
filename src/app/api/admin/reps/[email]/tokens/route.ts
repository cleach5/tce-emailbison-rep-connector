import { adminAuthorized, json, makeCtx } from "@/lib/context";
import { createRepToken } from "@/lib/tokens";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ email: string }> }) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const { email: raw } = await context.params;
  const email = decodeURIComponent(raw).trim().toLowerCase();
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  const ctx = await makeCtx("admin");
  const reps = await ctx.db.query(`SELECT email FROM rep_configs WHERE lower(email) = lower($1)`, [email]);
  if (!reps[0]) return json({ ok: false, error: "rep_not_found" }, 404);
  const created = await createRepToken(ctx.db, email, body.label?.trim() || "claude");
  return json({
    ok: true,
    id: created.id,
    rep_email: email,
    label: created.label,
    token: created.token,
    note: "Store this token now. It cannot be retrieved later. The database keeps only a hash.",
  });
}

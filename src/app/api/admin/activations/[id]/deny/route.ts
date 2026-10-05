import { denyActivation } from "@/lib/campaigns";
import { adminAuthorized, json, makeCtx } from "@/lib/context";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const ctx = await makeCtx("admin");
  const result = await denyActivation(ctx, id, body.reason);
  const status = result.ok ? 200 : result.code === "not_found" ? 404 : 409;
  return json(result, status);
}

import { approveActivation } from "@/lib/campaigns";
import { adminAuthorized, json, makeCtx } from "@/lib/context";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const { id } = await context.params;
  const ctx = await makeCtx("admin");
  const result = await approveActivation(ctx, id);
  const status = result.ok ? 200 : result.code === "not_found" ? 404 : 409;
  return json(result, status);
}

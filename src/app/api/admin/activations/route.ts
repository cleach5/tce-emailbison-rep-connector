import { listActivations } from "@/lib/campaigns";
import { adminAuthorized, json, makeCtx } from "@/lib/context";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  const ctx = await makeCtx("admin");
  return json(await listActivations(ctx, status));
}

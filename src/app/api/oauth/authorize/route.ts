import { getDb } from "@/lib/db";
import { publicBaseFromRequest, readEnv } from "@/lib/env";
import { beginAuthorization } from "@/lib/oauth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const db = await getDb();
  const started = await beginAuthorization(db, url.searchParams);
  if (!started.ok) {
    return Response.json(
      { error: started.error, error_description: started.description },
      { status: started.status },
    );
  }
  const base = publicBaseFromRequest(req, readEnv());
  return Response.redirect(`${base}/oauth/consent?txn=${encodeURIComponent(started.txn)}`, 302);
}

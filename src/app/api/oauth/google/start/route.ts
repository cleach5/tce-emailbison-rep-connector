import { getDb } from "@/lib/db";
import { publicBaseFromRequest, readEnv } from "@/lib/env";
import { googleRedirect } from "@/lib/oauth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const env = readEnv();
  const form = new URLSearchParams(await req.text());
  const txn = form.get("txn") ?? "";
  const db = await getDb();
  const rows = await db.query(`SELECT id FROM oauth_transactions WHERE id = $1`, [txn]);
  if (!rows[0]) {
    return new Response("This sign-in session expired. Start again from Claude.", { status: 400 });
  }
  if (!env.googleClientId || !env.googleClientSecret) {
    return new Response(
      "Google sign-in is not configured on this server. Use the personal bearer token your admin created for Claude Code or Claude Desktop.",
      { status: 503 },
    );
  }
  const base = publicBaseFromRequest(req, env);
  return Response.redirect(await googleRedirect(env, txn, base), 302);
}

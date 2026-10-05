import { getDb } from "@/lib/db";
import { microsoftConfigured, publicBaseFromRequest, readEnv } from "@/lib/env";
import { microsoftAuthorizeUrl, rememberProviderNonce } from "@/lib/oauth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const env = readEnv();
  const form = new URLSearchParams(await req.text());
  const txn = form.get("txn") ?? "";
  const db = await getDb();
  if (!microsoftConfigured(env)) {
    return new Response(
      "Microsoft sign-in is not configured on this server. Use the personal bearer token your admin created for Claude Code or Claude Desktop.",
      { status: 503 },
    );
  }
  const nonce = await rememberProviderNonce(db, txn);
  if (!nonce) {
    return new Response("This sign-in session expired. Start again from Claude.", { status: 400 });
  }
  const base = publicBaseFromRequest(req, env);
  return Response.redirect(microsoftAuthorizeUrl(env, txn, nonce, base), 302);
}

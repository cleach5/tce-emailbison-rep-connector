import { getDb } from "@/lib/db";
import { publicBaseFromRequest, readEnv } from "@/lib/env";
import { exchangeGoogleCode, issueCodeForTransaction, profileAllowed } from "@/lib/oauth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const env = readEnv();
  const url = new URL(req.url);
  const txn = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError || !code) {
    return new Response(`Google sign-in did not complete (${oauthError ?? "missing code"}).`, {
      status: 400,
    });
  }
  const base = publicBaseFromRequest(req, env);
  try {
    const profile = await exchangeGoogleCode(env, code, base);
    const email = profileAllowed(profile, env.allowedDomains);
    if (!email) {
      return new Response(
        "That Google account is outside the allowed Workspace domains for The Continental Exchange.",
        { status: 403 },
      );
    }
    const db = await getDb();
    const issued = await issueCodeForTransaction(db, txn, email);
    if ("error" in issued) return new Response(issued.error, { status: 403 });
    return Response.redirect(issued.redirect, 302);
  } catch (error) {
    console.error(error);
    return new Response("Google sign-in could not be completed.", { status: 400 });
  }
}

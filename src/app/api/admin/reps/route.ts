import { slugFromEmail } from "@/lib/campaigns";
import { adminAuthorized, json, makeCtx } from "@/lib/context";
import { domainAllowed, readEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const ctx = await makeCtx("admin");
  const reps = await ctx.db.query(
    `SELECT email, slug, display_name, sender_ids, owner_tag, created_at, updated_at FROM rep_configs ORDER BY email`,
  );
  const tokens = await ctx.db.query(
    `SELECT id, rep_email, label, token_hint, created_at, revoked_at FROM rep_tokens ORDER BY created_at DESC`,
  );
  return json({ ok: true, reps, tokens });
}

export async function POST(req: Request) {
  if (!adminAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  const body = (await req.json()) as {
    email?: string;
    display_name?: string;
    slug?: string;
    sender_ids?: number[];
    owner_tag?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const env = readEnv();
  if (!email.includes("@") || !domainAllowed(email, env.allowedDomains)) {
    return json({ ok: false, error: "email_domain_not_allowed" }, 400);
  }
  const slug = (body.slug ?? slugFromEmail(email)).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return json({ ok: false, error: "invalid_slug" }, 400);
  const senderIds = (body.sender_ids ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const ownerTag = (body.owner_tag ?? `owner:${slug}`).trim();
  const ctx = await makeCtx("admin");
  await ctx.db.query(
    `INSERT INTO rep_configs (email, slug, display_name, sender_ids, owner_tag)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (email) DO UPDATE SET
       slug = EXCLUDED.slug,
       display_name = EXCLUDED.display_name,
       sender_ids = EXCLUDED.sender_ids,
       owner_tag = EXCLUDED.owner_tag,
       updated_at = now()`,
    [email, slug, body.display_name?.trim() || slug, JSON.stringify(senderIds), ownerTag],
  );
  return json({
    ok: true,
    rep: { email, slug, display_name: body.display_name?.trim() || slug, sender_ids: senderIds, owner_tag: ownerTag },
  });
}

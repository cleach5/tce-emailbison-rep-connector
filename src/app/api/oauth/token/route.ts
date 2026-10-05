import { getDb } from "@/lib/db";
import { tokenRequest } from "@/lib/oauth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const text = await req.text();
  const form = new URLSearchParams(text);
  const db = await getDb();
  const result = await tokenRequest(db, form);
  return Response.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}

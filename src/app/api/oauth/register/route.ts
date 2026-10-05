import { getDb } from "@/lib/db";
import { registerClient } from "@/lib/oauth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    client_name?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  const db = await getDb();
  const result = await registerClient(db, body);
  return Response.json(result.body, { status: result.status });
}

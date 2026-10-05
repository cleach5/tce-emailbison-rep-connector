import { publicBaseFromRequest, readEnv } from "@/lib/env";
import { authorizationServerMetadata } from "@/lib/oauth";

export const runtime = "nodejs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function GET(req: Request) {
  const base = publicBaseFromRequest(req, readEnv());
  return Response.json(authorizationServerMetadata(base), { headers: cors });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

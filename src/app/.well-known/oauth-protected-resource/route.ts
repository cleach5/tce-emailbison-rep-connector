import { publicBaseFromRequest, readEnv } from "@/lib/env";
import { protectedResourceMetadata } from "@/lib/oauth";

export const runtime = "nodejs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function metadata(req: Request) {
  const base = publicBaseFromRequest(req, readEnv());
  return Response.json(protectedResourceMetadata(base), { headers: cors });
}

export { metadata as GET };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

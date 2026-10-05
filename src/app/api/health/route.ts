import { googleConfigured, microsoftConfigured, readEnv } from "@/lib/env";
import { WORKSPACE_ID } from "@/lib/constants";

export const runtime = "nodejs";

export function GET() {
  const env = readEnv();
  return Response.json({
    ok: true,
    service: "tce-campaign-connector",
    workspace_id: WORKSPACE_ID,
    bison_configured: Boolean(env.bisonApiKey),
    microsoft_configured: microsoftConfigured(env),
    google_configured: googleConfigured(env),
    allowed_domains: env.allowedDomains,
    mcp_path: "/api/mcp",
  });
}

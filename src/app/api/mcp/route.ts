import { readEnv } from "@/lib/env";
import { buildMcpHandler } from "@/lib/mcp";

export const runtime = "nodejs";
export const maxDuration = 60;

const env = readEnv();
const handler = buildMcpHandler(env.publicBaseUrl || undefined);

export { handler as GET, handler as POST, handler as DELETE };

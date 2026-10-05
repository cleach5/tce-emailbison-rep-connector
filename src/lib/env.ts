import { WORKSPACE_ID } from "./constants";

export type AppEnv = {
  bisonBaseUrl: string;
  bisonApiKey: string;
  adminToken: string;
  allowedDomains: string[];
  publicBaseUrl: string;
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  activationWebhookUrl: string;
  workspaceId: number;
};

function splitDomains(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export function readEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const requestedWorkspace = source.WORKSPACE_ID?.trim();
  if (requestedWorkspace && requestedWorkspace !== String(WORKSPACE_ID)) {
    throw new Error(
      `WORKSPACE_ID must be ${WORKSPACE_ID}. This connector cannot be pointed at another EmailBison workspace.`,
    );
  }
  return {
    bisonBaseUrl: (source.EMAILBISON_BASE_URL ?? "https://send.usatce.com").replace(/\/$/, ""),
    bisonApiKey: source.EMAILBISON_API_KEY ?? "",
    adminToken: source.ADMIN_TOKEN ?? "",
    allowedDomains: splitDomains(source.ALLOWED_EMAIL_DOMAINS),
    publicBaseUrl: (source.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    azureTenantId: source.AZURE_AD_TENANT_ID ?? "",
    azureClientId: source.AZURE_AD_CLIENT_ID ?? "",
    azureClientSecret: source.AZURE_AD_CLIENT_SECRET ?? "",
    googleClientId: source.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: source.GOOGLE_CLIENT_SECRET ?? "",
    activationWebhookUrl: source.ACTIVATION_WEBHOOK_URL ?? "",
    workspaceId: WORKSPACE_ID,
  };
}

export function publicBaseFromRequest(req: Request, env: AppEnv): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  return new URL(req.url).origin;
}

export function domainAllowed(email: string, domains: string[]): boolean {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  return domains.includes(domain);
}

export function microsoftConfigured(env: AppEnv): boolean {
  return Boolean(env.azureTenantId && env.azureClientId && env.azureClientSecret);
}

export function googleConfigured(env: AppEnv): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

import {
  CORPORATE_RECEIVING_DOMAIN_CAP,
  MAX_EMAILS_PER_DAY,
  MAX_NEW_LEADS_PER_DAY,
} from "./constants";

export type Audience = "personal" | "corporate";

export type AppliedCaps = {
  max_emails_per_day: number;
  max_new_leads_per_day: number;
  daily_max_sends_per_receiving_domain: number | null;
  clamped: boolean;
};

export function clampCaps(
  audience: Audience,
  requested: { max_emails_per_day: number; max_new_leads_per_day: number },
): AppliedCaps {
  const max_emails_per_day = Math.min(requested.max_emails_per_day, MAX_EMAILS_PER_DAY);
  const max_new_leads_per_day = Math.min(
    requested.max_new_leads_per_day,
    MAX_NEW_LEADS_PER_DAY,
  );
  return {
    max_emails_per_day,
    max_new_leads_per_day,
    daily_max_sends_per_receiving_domain:
      audience === "corporate" ? CORPORATE_RECEIVING_DOMAIN_CAP : null,
    clamped:
      max_emails_per_day !== requested.max_emails_per_day ||
      max_new_leads_per_day !== requested.max_new_leads_per_day,
  };
}

export function capsAreValid(
  audience: Audience,
  caps: {
    max_emails_per_day: number | null | undefined;
    max_new_leads_per_day: number | null | undefined;
    daily_max_sends_per_receiving_domain: number | null | undefined;
  },
): string[] {
  const problems: string[] = [];
  const emails = caps.max_emails_per_day;
  const leads = caps.max_new_leads_per_day;
  if (emails == null || emails < 1 || emails > MAX_EMAILS_PER_DAY) {
    problems.push(`max_emails_per_day must be between 1 and ${MAX_EMAILS_PER_DAY}.`);
  }
  if (leads == null || leads < 1 || leads > MAX_NEW_LEADS_PER_DAY) {
    problems.push(`max_new_leads_per_day must be between 1 and ${MAX_NEW_LEADS_PER_DAY}.`);
  }
  if (audience === "corporate") {
    if (caps.daily_max_sends_per_receiving_domain !== CORPORATE_RECEIVING_DOMAIN_CAP) {
      problems.push(
        `Corporate campaigns must keep daily_max_sends_per_receiving_domain at ${CORPORATE_RECEIVING_DOMAIN_CAP}.`,
      );
    }
  } else if (
    caps.daily_max_sends_per_receiving_domain != null
  ) {
    problems.push(
      "Personal campaigns must leave daily_max_sends_per_receiving_domain unset.",
    );
  }
  return problems;
}

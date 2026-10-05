/** EmailBison workspace this connector is allowed to touch. Not configurable. */
export const WORKSPACE_ID = 2;

/** Sender mailboxes on this exact domain are never exposed or attached. */
export const BLOCKED_SENDER_DOMAIN = "usatce.com";

export const MAX_NEW_LEADS_PER_DAY = 100;
export const MAX_EMAILS_PER_DAY = 250;
export const CORPORATE_RECEIVING_DOMAIN_CAP = 3;

/** Utilization above this fails preflight. 80% exactly is still allowed. */
export const SENDER_UTILIZATION_LIMIT = 0.8;

export const SURBL_TAG = "surbl";
export const SURBL_SYNC_MAX_MS = 48 * 60 * 60 * 1000;
/** Domains first seen before this instant are treated as SURBL when the sync is stale. */
export const SURBL_FAIL_CLOSED_BEFORE = "2026-10-01T00:00:00.000Z";

/** Day boundary used when counting a sender's scheduled mail. */
export const USAGE_TIMEZONE = "America/New_York";

export const REP_TOOL_NAMES = [
  "list_my_senders",
  "create_campaign_paused",
  "set_sequence",
  "set_schedule",
  "add_leads",
  "assign_senders",
  "set_caps",
  "get_my_campaign",
  "preflight_check",
  "request_activation",
  "list_my_campaigns",
  "get_campaign_stats",
  "get_activation_status",
  "my_daily_summary",
] as const;

export type RepToolName = (typeof REP_TOOL_NAMES)[number];

/**
 * How sender daily usage is computed for list_my_senders and preflight.
 * Scheduled emails are the API's direct record of what will send or already
 * sent today. Active-campaign caps cover volume that has not been materialized
 * into scheduled rows yet. Paused and draft campaigns do not add their cap.
 */
export const CAPACITY_METHOD =
  "usage_today = max(count of this sender's scheduled emails whose scheduled_date_local falls on today's America/New_York date and whose status is sent, scheduled, queued, or sending, sum of max_emails_per_day on campaigns in status launching, active, or queued that list this sender). Fail when daily_limit is missing or usage_today / daily_limit > 0.80. emails_sent_count on the sender is a lifetime counter and is not used.";

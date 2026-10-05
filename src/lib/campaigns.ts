import { createHash, randomBytes } from "node:crypto";
import { clampCaps, capsAreValid, type Audience } from "./caps";
import {
  BLOCKED_SENDER_DOMAIN,
  CAPACITY_METHOD,
  USAGE_TIMEZONE,
  SENDER_UTILIZATION_LIMIT,
} from "./constants";
import { checkCopy, type CopyStep, type RenderLead } from "./copy";
import { asNumberArray, asStringArray, jsonValue, type Queryable } from "./db";
import { BisonClient, BisonError, type BisonCampaign, type BisonSender } from "./bison";
import { asDate, senderIsSurbl } from "./surbl";
import { classifyEmail, emailDomain, isBlockedSenderDomain } from "./webmail";

export type AppCtx = {
  db: Queryable;
  bison: BisonClient;
  now: () => Date;
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
};

export type ToolResult = {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

type RepRow = {
  email: string;
  slug: string;
  display_name: string;
  sender_ids: unknown;
  owner_tag: string;
};

type CampaignRow = {
  bison_id: number;
  name: string;
  audience: Audience;
  owner_email: string;
  do_not_mention: unknown;
  sequence_id: number | null;
  max_emails_per_day: number | null;
  max_new_leads_per_day: number | null;
};

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): ToolResult {
  return { ok: false, code, message, ...details };
}

function nyDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: USAGE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function writeAudit(
  db: Queryable,
  repEmail: string,
  tool: string,
  args: unknown,
  result: ToolResult,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (rep_email, tool, args_summary, result) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
    [repEmail, tool, JSON.stringify(summarize(args)), JSON.stringify(summarize(result))],
  );
}

function summarize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { count: value.length, sample: value.slice(0, 5).map((item) => summarize(item)) };
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "email_body" && typeof item === "string") {
        output[key] = { length: item.length };
        continue;
      }
      output[key] = summarize(item);
    }
    return output;
  }
  return value;
}

async function audited(
  ctx: AppCtx,
  repEmail: string,
  tool: string,
  args: unknown,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await fn();
  } catch (error) {
    if (error instanceof ToolError) {
      result = fail(error.code, error.message, error.details);
    } else if (error instanceof BisonError) {
      result = fail(error.code, error.message);
    } else {
      console.error(`[${tool}]`, error);
      result = fail("internal", "The tool failed before it changed the campaign.");
    }
  }
  try {
    await writeAudit(ctx.db, repEmail, tool, args, result);
  } catch (error) {
    console.error("[audit]", error);
  }
  return result;
}

async function requireRep(db: Queryable, email: string): Promise<RepRow> {
  const rows = await db.query<RepRow>(`SELECT email, slug, display_name, sender_ids, owner_tag FROM rep_configs WHERE lower(email) = lower($1)`, [
    email,
  ]);
  const rep = rows[0];
  if (!rep) {
    throw new ToolError("rep_not_provisioned", "Your account is not on the rep mailbox map yet. Ask an admin to add you.");
  }
  return rep;
}

function senderOwned(sender: BisonSender, rep: RepRow): boolean {
  const ids = asNumberArray(rep.sender_ids);
  if (ids.includes(Number(sender.id))) return true;
  const wanted = rep.owner_tag.trim().toLowerCase();
  return (sender.tags ?? []).some((tag) => tag.name.trim().toLowerCase() === wanted);
}

async function requireOwnedCampaign(db: Queryable, rep: RepRow, campaignId: number): Promise<CampaignRow> {
  const rows = await db.query<CampaignRow>(
    `SELECT bison_id, name, audience, owner_email, do_not_mention, sequence_id, max_emails_per_day, max_new_leads_per_day
     FROM campaigns WHERE bison_id = $1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row || row.owner_email.toLowerCase() !== rep.email.toLowerCase()) {
    throw new ToolError("not_owner", "That campaign is not one you created.");
  }
  return row;
}

async function syncDomainFirstSeen(db: Queryable, senders: BisonSender[]): Promise<void> {
  for (const sender of senders) {
    const domain = emailDomain(sender.email);
    const created = asDate(sender.created_at);
    if (!domain || !created || domain === BLOCKED_SENDER_DOMAIN) continue;
    await db.query(
      `INSERT INTO domain_first_seen (domain, first_seen) VALUES ($1, $2)
       ON CONFLICT (domain) DO UPDATE SET first_seen = LEAST(domain_first_seen.first_seen, EXCLUDED.first_seen)`,
      [domain, created.toISOString()],
    );
  }
}

async function domainFirstSeenMap(db: Queryable): Promise<Map<string, Date>> {
  const rows = await db.query<{ domain: string; first_seen: unknown }>(
    `SELECT domain, first_seen FROM domain_first_seen`,
  );
  const map = new Map<string, Date>();
  for (const row of rows) {
    const seen = asDate(row.first_seen);
    if (seen) map.set(row.domain, seen);
  }
  return map;
}

async function lastSync(db: Queryable): Promise<Date | null> {
  const rows = await db.query<{ synced_at: unknown }>(`SELECT synced_at FROM surbl_sync WHERE id = 1`);
  return asDate(rows[0]?.synced_at);
}

async function annotateSender(db: Queryable, sender: BisonSender, now: Date) {
  const syncedAt = await lastSync(db);
  const firstSeen = await domainFirstSeenMap(db);
  const domain = emailDomain(sender.email);
  const decision = senderIsSurbl({
    email: sender.email,
    tags: sender.tags,
    createdAt: asDate(sender.created_at),
    domainFirstSeen: firstSeen.get(domain) ?? null,
    syncedAt,
    now,
  });
  return { decision, syncedAt, failClosed: decision.failClosed };
}

const COUNTABLE_STATUSES = new Set(["sent", "scheduled", "queued", "sending"]);
const ACTIVE_CAMPAIGN_STATUSES = new Set(["launching", "active", "queued"]);

export async function senderUsage(ctx: AppCtx, sender: BisonSender): Promise<{
  scheduled_today: number;
  active_cap_sum: number;
  usage_today: number;
  daily_limit: number | null;
  utilization: number | null;
  over_limit: boolean;
}> {
  const today = nyDate(ctx.now());
  const scheduled = await ctx.bison.listScheduled({ senderId: sender.id, localDate: today });
  const scheduledToday = scheduled.filter((row) =>
    COUNTABLE_STATUSES.has((row.status ?? "").toLowerCase()),
  ).length;
  const campaigns = await ctx.bison.listCampaigns();
  let activeCapSum = 0;
  for (const campaign of campaigns) {
    if (!ACTIVE_CAMPAIGN_STATUSES.has((campaign.status ?? "").toLowerCase())) continue;
    const attached = await ctx.bison.campaignSenders(campaign.id);
    if (!attached.some((item) => item.id === sender.id)) continue;
    activeCapSum += Number(campaign.max_emails_per_day ?? 0);
  }
  const usageToday = Math.max(scheduledToday, activeCapSum);
  const dailyLimit = sender.daily_limit == null ? null : Number(sender.daily_limit);
  const utilization = dailyLimit && dailyLimit > 0 ? usageToday / dailyLimit : null;
  const overLimit = dailyLimit == null || dailyLimit <= 0 || (utilization ?? 1) > SENDER_UTILIZATION_LIMIT;
  return {
    scheduled_today: scheduledToday,
    active_cap_sum: activeCapSum,
    usage_today: usageToday,
    daily_limit: dailyLimit,
    utilization,
    over_limit: overLimit,
  };
}

async function visibleSenders(ctx: AppCtx, rep: RepRow): Promise<BisonSender[]> {
  const senders = await ctx.bison.listSenders();
  await syncDomainFirstSeen(ctx.db, senders);
  return senders.filter((sender) => senderOwned(sender, rep) && !isBlockedSenderDomain(sender.email));
}

function repTag(rep: RepRow): string {
  return `rep:${rep.slug}`;
}

async function safeSettings(audience: Audience) {
  return {
    plain_text: true,
    open_tracking: false,
    can_unsubscribe: false,
    sequence_prioritization: "followups",
    daily_max_sends_per_receiving_domain: audience === "corporate" ? 3 : null,
  };
}

export async function listMySenders(ctx: AppCtx, repEmail: string): Promise<ToolResult> {
  return audited(ctx, repEmail, "list_my_senders", {}, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const senders = await visibleSenders(ctx, rep);
    const syncedAt = await lastSync(ctx.db);
    const listed = [];
    for (const sender of senders) {
      const { decision } = await annotateSender(ctx.db, sender, ctx.now());
      const usage = await senderUsage(ctx, sender);
      listed.push({
        id: sender.id,
        name: sender.name ?? "",
        email: sender.email,
        daily_limit: usage.daily_limit,
        emails_sent_count: sender.emails_sent_count ?? 0,
        usage_today: usage.usage_today,
        scheduled_today: usage.scheduled_today,
        active_cap_sum: usage.active_cap_sum,
        utilization: usage.utilization,
        surbl: decision.surbl,
        surbl_reason: decision.reason,
        tags: (sender.tags ?? []).map((tag) => tag.name),
        created_at: sender.created_at ?? null,
      });
    }
    return {
      ok: true,
      senders: listed,
      surbl_sync: {
        synced_at: syncedAt?.toISOString() ?? null,
        fail_closed: !syncedAt || ctx.now().getTime() - syncedAt.getTime() > 48 * 60 * 60 * 1000,
      },
      capacity_method: CAPACITY_METHOD,
    };
  });
}

export async function createCampaignPaused(
  ctx: AppCtx,
  repEmail: string,
  input: { name: string; audience: Audience; do_not_mention: string[] },
): Promise<ToolResult> {
  return audited(ctx, repEmail, "create_campaign_paused", input, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const names = input.do_not_mention.map((name) => name.trim()).filter((name) => name.length >= 2);
    if (input.audience !== "personal" && input.audience !== "corporate") {
      throw new ToolError("audience_required", "Campaign audience must be personal or corporate.");
    }
    if (names.length === 0) {
      throw new ToolError(
        "do_not_mention_required",
        "Provide the target company names this campaign must not mention in copy.",
      );
    }
    const created = await ctx.bison.createCampaign(input.name);
    const paused = await ctx.bison.pauseCampaign(created.id);
    await ctx.bison.updateCampaign(created.id, await safeSettings(input.audience));
    const tagId = await ctx.bison.ensureTag(repTag(rep));
    await ctx.bison.attachTagToCampaigns(tagId, [created.id]);
    await ctx.db.query(
      `INSERT INTO campaigns (bison_id, name, audience, owner_email, do_not_mention)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [created.id, input.name, input.audience, rep.email, JSON.stringify(names)],
    );
    return {
      ok: true,
      campaign_id: created.id,
      name: input.name,
      audience: input.audience,
      status: paused.status,
      do_not_mention: names,
      tag: repTag(rep),
      message: "Campaign created and paused. It stays paused until an admin approves activation.",
    };
  });
}

type SequenceInput = {
  campaign_id: number;
  title?: string;
  steps: {
    email_subject: string;
    email_body: string;
    wait_in_days: number;
    order?: number;
    thread_reply?: boolean;
    variant?: boolean;
  }[];
};

export async function setSequence(ctx: AppCtx, repEmail: string, input: SequenceInput): Promise<ToolResult> {
  return audited(ctx, repEmail, "set_sequence", input, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const campaign = await requireOwnedCampaign(ctx.db, rep, input.campaign_id);
    const leads = await ctx.bison.campaignLeads(campaign.bison_id);
    const steps: CopyStep[] = input.steps.map((step, index) => ({
      email_subject: step.email_subject,
      email_body: step.email_body,
      order: step.order ?? index + 1,
      variant: step.variant,
    }));
    const violations = checkCopy(steps, leads as RenderLead[], asStringArray(campaign.do_not_mention));
    if (violations.length) {
      throw new ToolError("copy_rejected", "Sequence copy failed the deliverability rules.", {
        violations,
      });
    }
    const title = input.title ?? `${campaign.name} sequence`;
    const payloadSteps = input.steps.map((step, index) => ({
      email_subject: step.email_subject,
      email_body: step.email_body,
      wait_in_days: step.wait_in_days,
      order: step.order ?? index + 1,
      variant: Boolean(step.variant),
      thread_reply: Boolean(step.thread_reply),
    }));
    const existing = await ctx.bison.getSequence(campaign.bison_id);
    let saved;
    if (existing.sequence_id && existing.sequence_steps.length === payloadSteps.length) {
      saved = await ctx.bison.updateSequence(
        existing.sequence_id,
        title,
        payloadSteps.map((step, index) => ({
          ...step,
          id: existing.sequence_steps[index]?.id,
        })),
      );
    } else {
      saved = await ctx.bison.createSequence(campaign.bison_id, title, payloadSteps);
    }
    await ctx.db.query(`UPDATE campaigns SET sequence_id = $2 WHERE bison_id = $1`, [
      campaign.bison_id,
      saved.id,
    ]);
    return {
      ok: true,
      campaign_id: campaign.bison_id,
      sequence_id: saved.id,
      steps: saved.sequence_steps.length,
    };
  });
}

export async function setSchedule(
  ctx: AppCtx,
  repEmail: string,
  input: {
    campaign_id: number;
    monday: boolean;
    tuesday: boolean;
    wednesday: boolean;
    thursday: boolean;
    friday: boolean;
    saturday: boolean;
    sunday: boolean;
    start_time: string;
    end_time: string;
    timezone: string;
  },
): Promise<ToolResult> {
  return audited(ctx, repEmail, "set_schedule", input, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const campaign = await requireOwnedCampaign(ctx.db, rep, input.campaign_id);
    const existing = await ctx.bison.getSchedule(campaign.bison_id);
    const { campaign_id: _id, ...schedule } = input;
    const saved = await ctx.bison.saveSchedule(campaign.bison_id, schedule, Boolean(existing));
    return { ok: true, campaign_id: campaign.bison_id, schedule: saved };
  });
}

type LeadInput = {
  email: string;
  first_name: string;
  last_name?: string;
  company?: string;
  title?: string;
  custom_variables?: { name: string; value: string }[];
};

export async function addLeads(
  ctx: AppCtx,
  repEmail: string,
  input: { campaign_id: number; leads: LeadInput[] },
): Promise<ToolResult> {
  return audited(ctx, repEmail, "add_leads", { campaign_id: input.campaign_id, lead_count: input.leads.length }, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const campaign = await requireOwnedCampaign(ctx.db, rep, input.campaign_id);
    const personal: LeadInput[] = [];
    const corporate: LeadInput[] = [];
    const invalid: string[] = [];
    for (const lead of input.leads) {
      const kind = classifyEmail(lead.email);
      if (kind === "invalid") invalid.push(lead.email);
      else if (kind === "personal") personal.push(lead);
      else corporate.push(lead);
    }
    const attachedSenders = await ctx.bison.campaignSenders(campaign.bison_id);
    await syncDomainFirstSeen(ctx.db, attachedSenders);
    const surblSenders = [];
    for (const sender of attachedSenders) {
      const { decision } = await annotateSender(ctx.db, sender, ctx.now());
      if (decision.surbl) surblSenders.push({ id: sender.id, email: sender.email, reason: decision.reason });
    }
    const rejected: { email: string; reason: string }[] = invalid.map((email) => ({
      email,
      reason: "invalid_email",
    }));
    if (campaign.audience === "personal") {
      for (const lead of corporate) rejected.push({ email: lead.email, reason: "corporate_lead_on_personal" });
    } else {
      for (const lead of personal) rejected.push({ email: lead.email, reason: "personal_lead_on_corporate" });
    }
    if (surblSenders.length) {
      for (const lead of corporate) {
        if (!rejected.some((item) => item.email === lead.email && item.reason === "corporate_lead_with_surbl_sender")) {
          rejected.push({ email: lead.email, reason: "corporate_lead_with_surbl_sender" });
        }
      }
    }
    const split = {
      personal: personal.map((lead) => lead.email),
      corporate: corporate.map((lead) => lead.email),
      rejected,
      surbl_sender_ids: surblSenders.map((sender) => sender.id),
    };
    if (rejected.length) {
      const code = rejected.some((item) => item.reason === "corporate_lead_with_surbl_sender")
        ? "corporate_lead_with_surbl_sender"
        : campaign.audience === "personal"
          ? "corporate_lead_on_personal"
          : "personal_lead_on_corporate";
      throw new ToolError(
        code,
        "No leads were attached. Split personal and corporate addresses into matching campaigns.",
        split,
      );
    }
    const saved = await ctx.bison.upsertLeads(input.leads);
    await ctx.bison.attachLeads(
      campaign.bison_id,
      saved.map((lead) => lead.id),
    );
    return {
      ok: true,
      campaign_id: campaign.bison_id,
      attached: saved.map((lead) => ({ id: lead.id, email: lead.email })),
      ...split,
    };
  });
}

export async function assignSenders(
  ctx: AppCtx,
  repEmail: string,
  input: { campaign_id: number; sender_email_ids: number[] },
): Promise<ToolResult> {
  return audited(ctx, repEmail, "assign_senders", input, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const campaign = await requireOwnedCampaign(ctx.db, rep, input.campaign_id);
    const all = await ctx.bison.listSenders();
    await syncDomainFirstSeen(ctx.db, all);
    const refused: { id: number; reason: string }[] = [];
    const accepted: BisonSender[] = [];
    for (const id of input.sender_email_ids) {
      const sender = all.find((item) => item.id === id);
      if (!sender || !senderOwned(sender, rep)) {
        refused.push({ id, reason: "sender_not_owned" });
        continue;
      }
      if (isBlockedSenderDomain(sender.email)) {
        refused.push({ id, reason: "sender_domain_blocked" });
        continue;
      }
      const { decision } = await annotateSender(ctx.db, sender, ctx.now());
      if (campaign.audience === "corporate" && decision.surbl) {
        refused.push({ id, reason: "surbl_on_corporate" });
        continue;
      }
      accepted.push(sender);
    }
    if (refused.length) {
      throw new ToolError("sender_refused", "No senders were attached.", {
        refused,
        accepted_ids: [],
      });
    }
    await ctx.bison.attachSenders(
      campaign.bison_id,
      accepted.map((sender) => sender.id),
    );
    return {
      ok: true,
      campaign_id: campaign.bison_id,
      sender_email_ids: accepted.map((sender) => sender.id),
    };
  });
}

export async function setCaps(
  ctx: AppCtx,
  repEmail: string,
  input: { campaign_id: number; max_emails_per_day: number; max_new_leads_per_day: number },
): Promise<ToolResult> {
  return audited(ctx, repEmail, "set_caps", input, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const campaign = await requireOwnedCampaign(ctx.db, rep, input.campaign_id);
    const applied = clampCaps(campaign.audience, input);
    await ctx.bison.updateCampaign(campaign.bison_id, {
      max_emails_per_day: applied.max_emails_per_day,
      max_new_leads_per_day: applied.max_new_leads_per_day,
      ...(await safeSettings(campaign.audience)),
    });
    await ctx.db.query(
      `UPDATE campaigns SET max_emails_per_day = $2, max_new_leads_per_day = $3 WHERE bison_id = $1`,
      [campaign.bison_id, applied.max_emails_per_day, applied.max_new_leads_per_day],
    );
    return {
      ok: true,
      campaign_id: campaign.bison_id,
      ...applied,
      message: applied.clamped
        ? "Caps were clamped to the workspace maximum."
        : "Caps saved.",
    };
  });
}

export async function getMyCampaign(ctx: AppCtx, repEmail: string, campaignId: number): Promise<ToolResult> {
  return audited(ctx, repEmail, "get_my_campaign", { campaign_id: campaignId }, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const local = await requireOwnedCampaign(ctx.db, rep, campaignId);
    const [remote, sequence, schedule, senders, leads] = await Promise.all([
      ctx.bison.getCampaign(campaignId),
      ctx.bison.getSequence(campaignId),
      ctx.bison.getSchedule(campaignId),
      ctx.bison.campaignSenders(campaignId),
      ctx.bison.campaignLeads(campaignId),
    ]);
    return {
      ok: true,
      campaign: {
        ...remote,
        audience: local.audience,
        do_not_mention: asStringArray(local.do_not_mention),
        owner_email: local.owner_email,
      },
      sequence,
      schedule,
      senders: senders.map((sender) => ({
        id: sender.id,
        email: sender.email,
        daily_limit: sender.daily_limit ?? null,
        tags: (sender.tags ?? []).map((tag) => tag.name),
      })),
      leads: leads.map((lead) => ({ id: lead.id, email: lead.email, first_name: lead.first_name })),
    };
  });
}

type Preflight = {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: unknown }[];
  capacity_method: string;
};

function settingsProblems(campaign: BisonCampaign): string[] {
  const problems: string[] = [];
  if (campaign.plain_text !== true) problems.push("plain_text must stay on.");
  if (campaign.open_tracking !== false) problems.push("open tracking must stay off.");
  if (campaign.can_unsubscribe !== false) problems.push("the unsubscribe link must stay off.");
  if ((campaign.status ?? "").toLowerCase() !== "paused") problems.push("the campaign must be paused.");
  return problems;
}

export async function runPreflight(ctx: AppCtx, rep: RepRow, local: CampaignRow): Promise<Preflight> {
  const checks: Preflight["checks"] = [];
  const remote = await ctx.bison.getCampaign(local.bison_id);
  const settings = settingsProblems(remote);
  const capProblems = capsAreValid(local.audience, {
    max_emails_per_day: remote.max_emails_per_day,
    max_new_leads_per_day: remote.max_new_leads_per_day,
    daily_max_sends_per_receiving_domain: remote.daily_max_sends_per_receiving_domain,
  });
  checks.push({
    name: "settings",
    ok: settings.length === 0,
    detail: settings,
  });
  checks.push({ name: "caps", ok: capProblems.length === 0, detail: capProblems });

  const sequence = await ctx.bison.getSequence(local.bison_id);
  const leads = await ctx.bison.campaignLeads(local.bison_id);
  const doNotMention = asStringArray(local.do_not_mention);
  const steps: CopyStep[] = sequence.sequence_steps.map((step) => ({
    email_subject: step.email_subject,
    email_body: step.email_body,
    order: step.order,
    variant: step.variant,
  }));
  const violations = steps.length
    ? checkCopy(steps, leads as RenderLead[], doNotMention)
    : [{ code: "missing_sequence" as const, message: "Add a sequence before activation." }];
  checks.push({
    name: "copy",
    ok: steps.length > 0 && violations.length === 0,
    detail: violations,
  });

  const senders = await ctx.bison.campaignSenders(local.bison_id);
  await syncDomainFirstSeen(ctx.db, senders);
  const senderProblems: { id: number; email?: string; reason: string }[] = [];
  const surblIds: number[] = [];
  if (senders.length === 0) senderProblems.push({ id: 0, reason: "no_senders" });
  for (const sender of senders) {
    if (!senderOwned(sender, rep)) senderProblems.push({ id: sender.id, email: sender.email, reason: "sender_not_owned" });
    if (isBlockedSenderDomain(sender.email)) {
      senderProblems.push({ id: sender.id, email: sender.email, reason: "sender_domain_blocked" });
    }
    const { decision } = await annotateSender(ctx.db, sender, ctx.now());
    if (decision.surbl) surblIds.push(sender.id);
    if (local.audience === "corporate" && decision.surbl) {
      senderProblems.push({ id: sender.id, email: sender.email, reason: "surbl_on_corporate" });
    }
  }
  checks.push({ name: "senders", ok: senderProblems.length === 0, detail: senderProblems });

  const leadProblems: { email: string; reason: string }[] = [];
  let personalCount = 0;
  let corporateCount = 0;
  for (const lead of leads) {
    const kind = classifyEmail(lead.email);
    if (kind === "personal") personalCount += 1;
    if (kind === "corporate") corporateCount += 1;
    if (kind === "invalid") leadProblems.push({ email: lead.email, reason: "invalid_email" });
    if (local.audience === "personal" && kind === "corporate") {
      leadProblems.push({ email: lead.email, reason: "corporate_lead_on_personal" });
    }
    if (local.audience === "corporate" && kind === "personal") {
      leadProblems.push({ email: lead.email, reason: "personal_lead_on_corporate" });
    }
    if (surblIds.length && kind === "corporate") {
      leadProblems.push({ email: lead.email, reason: "corporate_lead_with_surbl_sender" });
    }
  }
  checks.push({
    name: "leads",
    ok: leadProblems.length === 0,
    detail: { personal: personalCount, corporate: corporateCount, problems: leadProblems },
  });

  const capacity: {
    id: number;
    email: string;
    utilization: number | null;
    usage_today: number;
    daily_limit: number | null;
    over_limit: boolean;
  }[] = [];
  for (const sender of senders) {
    if (isBlockedSenderDomain(sender.email)) continue;
    const usage = await senderUsage(ctx, sender);
    capacity.push({
      id: sender.id,
      email: sender.email,
      utilization: usage.utilization,
      usage_today: usage.usage_today,
      daily_limit: usage.daily_limit,
      over_limit: usage.over_limit,
    });
  }
  checks.push({
    name: "sender_capacity",
    ok: capacity.every((item) => !item.over_limit) && senders.length > 0,
    detail: capacity,
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    capacity_method: CAPACITY_METHOD,
  };
}

export async function preflightCheck(ctx: AppCtx, repEmail: string, campaignId: number): Promise<ToolResult> {
  return audited(ctx, repEmail, "preflight_check", { campaign_id: campaignId }, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const local = await requireOwnedCampaign(ctx.db, rep, campaignId);
    const preflight = await runPreflight(ctx, rep, local);
    return { ok: preflight.ok, code: preflight.ok ? undefined : "preflight_failed", preflight };
  });
}

function firstTouch(steps: { order?: number; email_subject: string; email_body: string; variant?: boolean }[]) {
  const ordered = [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const step = ordered.find((item) => !item.variant) ?? ordered[0];
  if (!step) return { email_subject: "", email_body: "" };
  return { email_subject: step.email_subject, email_body: step.email_body };
}

export async function requestActivation(ctx: AppCtx, repEmail: string, campaignId: number): Promise<ToolResult> {
  return audited(ctx, repEmail, "request_activation", { campaign_id: campaignId }, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const local = await requireOwnedCampaign(ctx.db, rep, campaignId);
    const preflight = await runPreflight(ctx, rep, local);
    if (!preflight.ok) {
      return {
        ok: false,
        code: "preflight_failed",
        message: "Activation was not requested because preflight failed.",
        preflight,
      };
    }
    const remote = await ctx.bison.getCampaign(campaignId);
    const leads = await ctx.bison.campaignLeads(campaignId);
    const senders = await ctx.bison.campaignSenders(campaignId);
    const sequence = await ctx.bison.getSequence(campaignId);
    let personal = 0;
    let corporate = 0;
    for (const lead of leads) {
      const kind = classifyEmail(lead.email);
      if (kind === "personal") personal += 1;
      if (kind === "corporate") corporate += 1;
    }
    const id = `act_${randomBytes(12).toString("hex")}`;
    await ctx.db.query(
      `UPDATE activation_requests SET status = 'superseded', decided_at = now()
       WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId],
    );
    const leadCounts = { personal, corporate, total: leads.length };
    const senderSummary = senders.map((sender) => ({
      id: sender.id,
      email: sender.email,
      daily_limit: sender.daily_limit ?? null,
    }));
    const caps = {
      max_emails_per_day: remote.max_emails_per_day ?? null,
      max_new_leads_per_day: remote.max_new_leads_per_day ?? null,
      daily_max_sends_per_receiving_domain: remote.daily_max_sends_per_receiving_domain ?? null,
      audience: local.audience,
    };
    const touch = firstTouch(sequence.sequence_steps);
    await ctx.db.query(
      `INSERT INTO activation_requests
        (id, campaign_id, rep_email, status, preflight, lead_counts, senders, caps, first_touch)
       VALUES ($1, $2, $3, 'pending', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [
        id,
        campaignId,
        rep.email,
        JSON.stringify(preflight),
        JSON.stringify(leadCounts),
        JSON.stringify(senderSummary),
        JSON.stringify(caps),
        JSON.stringify(touch),
      ],
    );
    let webhook: { delivered: boolean; error?: string } | undefined;
    if (ctx.webhookUrl) {
      try {
        const response = await (ctx.fetchImpl ?? fetch)(ctx.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "activation.requested",
            id,
            campaign_id: campaignId,
            rep_email: rep.email,
            audience: local.audience,
            created_at: ctx.now().toISOString(),
          }),
        });
        webhook = { delivered: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
      } catch (error) {
        webhook = { delivered: false, error: error instanceof Error ? error.message : "webhook failed" };
      }
    }
    return {
      ok: true,
      activation_id: id,
      status: "pending",
      campaign_id: campaignId,
      lead_counts: leadCounts,
      webhook,
      message: "Activation is pending. The campaign stays paused until an admin approves it.",
    };
  });
}

export async function listActivations(ctx: AppCtx, status = "pending"): Promise<ToolResult> {
  const rows = await ctx.db.query(
    `SELECT id, campaign_id, rep_email, status, preflight, lead_counts, senders, caps, first_touch, deny_reason, created_at, decided_at
     FROM activation_requests WHERE status = $1 ORDER BY created_at ASC`,
    [status],
  );
  return {
    ok: true,
    requests: rows.map((row) => ({
      ...row,
      preflight: jsonValue((row as { preflight: unknown }).preflight),
      lead_counts: jsonValue((row as { lead_counts: unknown }).lead_counts),
      senders: jsonValue((row as { senders: unknown }).senders),
      caps: jsonValue((row as { caps: unknown }).caps),
      first_touch: jsonValue((row as { first_touch: unknown }).first_touch),
      created_at: asDate((row as { created_at: unknown }).created_at)?.toISOString() ?? null,
      decided_at: asDate((row as { decided_at: unknown }).decided_at)?.toISOString() ?? null,
    })),
  };
}

export async function approveActivation(ctx: AppCtx, id: string): Promise<ToolResult> {
  const rows = await ctx.db.query<{
    id: string;
    campaign_id: number;
    rep_email: string;
    status: string;
  }>(`SELECT id, campaign_id, rep_email, status FROM activation_requests WHERE id = $1`, [id]);
  const request = rows[0];
  if (!request) return fail("not_found", "No activation request with that id.");
  if (request.status !== "pending") return fail("not_pending", `Request is ${request.status}.`);
  const rep = await requireRep(ctx.db, request.rep_email);
  const local = await requireOwnedCampaign(ctx.db, rep, request.campaign_id);
  const preflight = await runPreflight(ctx, rep, local);
  if (!preflight.ok) {
    return {
      ok: false,
      code: "preflight_failed",
      message: "Approval did not resume the campaign because preflight failed again.",
      id,
      preflight,
    };
  }
  const resumed = await ctx.bison.resumeCampaign(request.campaign_id);
  await ctx.db.query(
    `UPDATE activation_requests SET status = 'approved', decided_at = now(), preflight = $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(preflight)],
  );
  await writeAudit(ctx.db, "admin", "admin.approve", { id }, { ok: true, campaign_id: request.campaign_id });
  return {
    ok: true,
    id,
    status: "approved",
    campaign_id: request.campaign_id,
    bison_status: resumed.status,
    preflight,
  };
}

export async function denyActivation(ctx: AppCtx, id: string, reason?: string): Promise<ToolResult> {
  const rows = await ctx.db.query<{ status: string; campaign_id: number }>(
    `SELECT status, campaign_id FROM activation_requests WHERE id = $1`,
    [id],
  );
  const request = rows[0];
  if (!request) return fail("not_found", "No activation request with that id.");
  if (request.status !== "pending") return fail("not_pending", `Request is ${request.status}.`);
  const denyReason = cleanDenyReason(reason);
  await ctx.db.query(
    `UPDATE activation_requests SET status = 'denied', deny_reason = $2, decided_at = now() WHERE id = $1`,
    [id, denyReason],
  );
  await writeAudit(ctx.db, "admin", "admin.deny", { id, reason: denyReason }, { ok: true });
  return {
    ok: true,
    id,
    status: "denied",
    campaign_id: request.campaign_id,
    deny_reason: denyReason,
  };
}

function cleanDenyReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim().slice(0, 1000);
  return trimmed.length ? trimmed : null;
}

type ActivationView = {
  id: string;
  status: string;
  deny_reason: string | null;
  created_at: string | null;
  decided_at: string | null;
};

function countOf(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shiftNyDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const cursor = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

async function activationHistory(db: Queryable, repEmail: string, campaignId: number): Promise<ActivationView[]> {
  const rows = await db.query<{
    id: string;
    status: string;
    deny_reason: string | null;
    created_at: unknown;
    decided_at: unknown;
  }>(
    `SELECT id, status, deny_reason, created_at, decided_at
     FROM activation_requests
     WHERE campaign_id = $1 AND lower(rep_email) = lower($2)
     ORDER BY created_at DESC`,
    [campaignId, repEmail],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    deny_reason: row.deny_reason,
    created_at: asDate(row.created_at)?.toISOString() ?? null,
    decided_at: asDate(row.decided_at)?.toISOString() ?? null,
  }));
}

async function ownedCampaignRows(db: Queryable, repEmail: string): Promise<Array<CampaignRow & { created_at: unknown }>> {
  return db.query<CampaignRow & { created_at: unknown }>(
    `SELECT bison_id, name, audience, owner_email, do_not_mention, sequence_id, max_emails_per_day, max_new_leads_per_day, created_at
     FROM campaigns WHERE lower(owner_email) = lower($1) ORDER BY created_at ASC`,
    [repEmail],
  );
}

async function campaignStatusRow(ctx: AppCtx, rep: RepRow, row: CampaignRow & { created_at: unknown }) {
  const remote = await ctx.bison.getCampaign(row.bison_id);
  const history = await activationHistory(ctx.db, rep.email, row.bison_id);
  const latest = history[0] ?? null;
  return {
    campaign_id: row.bison_id,
    name: remote.name || row.name,
    audience: row.audience,
    status: remote.status ?? null,
    created_at: remote.created_at ?? asDate(row.created_at)?.toISOString() ?? null,
    leads: countOf(remote.total_leads),
    sent: countOf(remote.emails_sent),
    replies: countOf(remote.replied),
    bounces: countOf(remote.bounced),
    interested: countOf(remote.interested),
    activation: latest
      ? { id: latest.id, status: latest.status, deny_reason: latest.deny_reason }
      : { id: null, status: "none", deny_reason: null },
  };
}

function upcomingScheduled(rows: { status?: string; scheduled_date_local?: string; email_subject?: string; id: number; sender_email_id?: number; sender_email?: { id: number }; lead?: { email?: string } }[], now: Date) {
  const start = now.getTime();
  const end = start + 48 * 60 * 60 * 1000;
  const upcoming = [];
  for (const row of rows) {
    const status = (row.status ?? "").toLowerCase();
    if (status !== "scheduled" && status !== "queued" && status !== "sending") continue;
    const when = Date.parse(row.scheduled_date_local ?? "");
    if (Number.isNaN(when) || when < start || when > end) continue;
    upcoming.push({
      id: row.id,
      status,
      scheduled_date_local: row.scheduled_date_local ?? null,
      sender_email_id: row.sender_email_id ?? row.sender_email?.id ?? null,
      lead_email: row.lead?.email ?? null,
      email_subject: row.email_subject ?? null,
    });
  }
  upcoming.sort((left, right) => String(left.scheduled_date_local).localeCompare(String(right.scheduled_date_local)));
  return upcoming;
}

async function statsForCampaign(ctx: AppCtx, campaignId: number) {
  const today = nyDate(ctx.now());
  const start = shiftNyDate(today, -6);
  const [remote, daily, scheduled] = await Promise.all([
    ctx.bison.getCampaign(campaignId),
    ctx.bison.chartStats(campaignId, start, today),
    ctx.bison.campaignScheduled(campaignId),
  ]);
  const scheduledByDate = new Map<string, number>();
  for (const row of scheduled) {
    const status = (row.status ?? "").toLowerCase();
    if (status !== "scheduled" && status !== "queued" && status !== "sending") continue;
    const date = (row.scheduled_date_local ?? "").slice(0, 10);
    if (!date) continue;
    scheduledByDate.set(date, (scheduledByDate.get(date) ?? 0) + 1);
  }
  const days = daily.map((row) => ({
    ...row,
    scheduled: scheduledByDate.get(row.date) ?? 0,
  }));
  const upcoming = upcomingScheduled(scheduled, ctx.now());
  return {
    campaign_id: campaignId,
    status: remote.status ?? null,
    leads: countOf(remote.total_leads),
    sent: countOf(remote.emails_sent),
    replies: countOf(remote.replied),
    bounces: countOf(remote.bounced),
    interested: countOf(remote.interested),
    daily: days,
    scheduled_next_48h_count: upcoming.length,
    scheduled_next_48h: upcoming.slice(0, 25),
  };
}

export async function listMyCampaigns(ctx: AppCtx, repEmail: string): Promise<ToolResult> {
  return audited(ctx, repEmail, "list_my_campaigns", {}, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const rows = await ownedCampaignRows(ctx.db, rep.email);
    const campaigns = [];
    for (const row of rows) campaigns.push(await campaignStatusRow(ctx, rep, row));
    return { ok: true, campaigns };
  });
}

export async function getCampaignStats(ctx: AppCtx, repEmail: string, campaignId: number): Promise<ToolResult> {
  return audited(ctx, repEmail, "get_campaign_stats", { campaign_id: campaignId }, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    await requireOwnedCampaign(ctx.db, rep, campaignId);
    const stats = await statsForCampaign(ctx, campaignId);
    return {
      ok: true,
      ...stats,
      note: "Reply, bounce, and interested figures are counts. Reply text is not available from this connector.",
    };
  });
}

export async function getActivationStatus(ctx: AppCtx, repEmail: string, campaignId: number): Promise<ToolResult> {
  return audited(ctx, repEmail, "get_activation_status", { campaign_id: campaignId }, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    await requireOwnedCampaign(ctx.db, rep, campaignId);
    const requests = await activationHistory(ctx.db, rep.email, campaignId);
    const latest = requests[0] ?? null;
    return {
      ok: true,
      campaign_id: campaignId,
      status: latest?.status ?? "none",
      deny_reason: latest?.deny_reason ?? null,
      requests,
    };
  });
}

export async function myDailySummary(ctx: AppCtx, repEmail: string): Promise<ToolResult> {
  return audited(ctx, repEmail, "my_daily_summary", {}, async () => {
    const rep = await requireRep(ctx.db, repEmail);
    const senders = await visibleSenders(ctx, rep);
    const mailboxes = [];
    for (const sender of senders) {
      const { decision } = await annotateSender(ctx.db, sender, ctx.now());
      const usage = await senderUsage(ctx, sender);
      mailboxes.push({
        id: sender.id,
        email: sender.email,
        daily_limit: usage.daily_limit,
        usage_today: usage.usage_today,
        utilization: usage.utilization,
        over_80_percent: usage.utilization != null && usage.utilization > SENDER_UTILIZATION_LIMIT,
        surbl: decision.surbl,
      });
    }
    const rows = await ownedCampaignRows(ctx.db, rep.email);
    const campaigns = [];
    for (const row of rows) {
      const status = await campaignStatusRow(ctx, rep, row);
      const stats = await statsForCampaign(ctx, row.bison_id);
      const today = stats.daily.find((day) => day.date === nyDate(ctx.now()));
      campaigns.push({
        ...status,
        sent_today: today?.sent ?? 0,
        scheduled_today: today?.scheduled ?? 0,
        scheduled_next_48h_count: stats.scheduled_next_48h_count,
      });
    }
    const denied = campaigns
      .filter((campaign) => campaign.activation.status === "denied")
      .map((campaign) => ({
        campaign_id: campaign.campaign_id,
        name: campaign.name,
        deny_reason: campaign.activation.deny_reason,
      }));
    return {
      ok: true,
      as_of: ctx.now().toISOString(),
      timezone: USAGE_TIMEZONE,
      date: nyDate(ctx.now()),
      mailboxes,
      mailboxes_over_80_percent: mailboxes.filter((mailbox) => mailbox.over_80_percent).map((mailbox) => mailbox.email),
      campaigns,
      pending_activations: campaigns.filter((campaign) => campaign.activation.status === "pending").length,
      denied,
      totals: {
        leads: campaigns.reduce((sum, campaign) => sum + campaign.leads, 0),
        sent: campaigns.reduce((sum, campaign) => sum + campaign.sent, 0),
        replies: campaigns.reduce((sum, campaign) => sum + campaign.replies, 0),
        bounces: campaigns.reduce((sum, campaign) => sum + campaign.bounces, 0),
        interested: campaigns.reduce((sum, campaign) => sum + campaign.interested, 0),
        scheduled_next_48h: campaigns.reduce((sum, campaign) => sum + campaign.scheduled_next_48h_count, 0),
      },
      note: "Counts only. This connector does not return reply text and cannot resume a campaign.",
    };
  });
}

export async function recordSurblSync(
  ctx: AppCtx,
  input: { synced_at?: string; domains?: string[] },
): Promise<ToolResult> {
  const syncedAt = input.synced_at ? asDate(input.synced_at) : ctx.now();
  if (!syncedAt) return fail("invalid_timestamp", "synced_at is not a valid timestamp.");
  const domains = (input.domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  await ctx.db.query(
    `UPDATE surbl_sync SET synced_at = $1, domains = $2::jsonb, updated_at = now() WHERE id = 1`,
    [syncedAt.toISOString(), JSON.stringify(domains)],
  );
  let tagged: number[] = [];
  if (input.domains) {
    const senders = await ctx.bison.listSenders();
    await syncDomainFirstSeen(ctx.db, senders);
    tagged = senders
      .filter((sender) => domains.includes(emailDomain(sender.email)))
      .map((sender) => sender.id);
    if (tagged.length) {
      const tagId = await ctx.bison.ensureTag("surbl");
      await ctx.bison.attachTagToSenders(tagId, tagged);
    }
  }
  await writeAudit(ctx.db, "admin", "admin.surbl_sync", { synced_at: syncedAt.toISOString(), domains }, {
    ok: true,
    tagged_sender_ids: tagged,
  });
  return {
    ok: true,
    synced_at: syncedAt.toISOString(),
    tagged_sender_ids: tagged,
    note: "Passing domains attaches the surbl tag. It does not remove the tag from other senders.",
  };
}

export function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "rep";
  const slug = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "rep";
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

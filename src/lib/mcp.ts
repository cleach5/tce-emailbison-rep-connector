import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import {
  addLeads,
  assignSenders,
  createCampaignPaused,
  getActivationStatus,
  getCampaignStats,
  getMyCampaign,
  listMyCampaigns,
  listMySenders,
  myDailySummary,
  preflightCheck,
  requestActivation,
  setCaps,
  setSchedule,
  setSequence,
  type ToolResult,
} from "./campaigns";
import { REP_TOOL_NAMES } from "./constants";
import { makeCtx } from "./context";
import { verifyBearer } from "./oauth";
import { getDb } from "./db";

const time = z.string().regex(/^\d{2}:\d{2}$/);

function textResult(result: ToolResult) {
  return {
    isError: result.ok === false,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}

function emailFrom(ctx: { http?: { authInfo?: { extra?: Record<string, unknown> } } }): string {
  const email = ctx.http?.authInfo?.extra?.email;
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("Missing rep identity on the access token.");
  }
  return email;
}

export function buildMcpHandler(resourceUrl?: string) {
  const handler = createMcpHandler(
    (server) => {
      server.registerTool(
        "list_my_senders",
        {
          description:
            "List only this rep's EmailBison sender mailboxes, with daily_limit, today's usage, and whether the mailbox is SURBL. usatce.com mailboxes are never returned. The server never changes a sender's daily_limit.",
          inputSchema: z.object({}),
        },
        async (_args, ctx) => textResult(await listMySenders(await makeCtx("rep"), emailFrom(ctx))),
      );

      server.registerTool(
        "create_campaign_paused",
        {
          description:
            "Create an outbound EmailBison campaign and immediately pause it. audience must be personal or corporate. do_not_mention is the list of target company names the copy must not contain. The campaign is tagged rep:<you> and recorded as yours. Nothing you can call will resume it.",
          inputSchema: z.object({
            name: z.string().min(1),
            audience: z.enum(["personal", "corporate"]),
            do_not_mention: z.array(z.string().min(2)).min(1),
          }),
        },
        async (args, ctx) => textResult(await createCampaignPaused(await makeCtx("rep"), emailFrom(ctx), args)),
      );

      server.registerTool(
        "set_sequence",
        {
          description:
            "Replace the sequence on a campaign you created. Copy is rejected when it repeats a normalized sentence or rendered body across more than 5 sends, mentions a do-not-mention name, or contains confidential, compliance, general perspective, a dollar or hourly rate, or an em/en dash. Variables like {FIRST_NAME} and spintax {Hi|Hello} are rendered per lead.",
          inputSchema: z.object({
            campaign_id: z.number().int().positive(),
            title: z.string().min(1).optional(),
            steps: z
              .array(
                z.object({
                  email_subject: z.string().min(1),
                  email_body: z.string().min(1),
                  wait_in_days: z.number().int().min(0),
                  order: z.number().int().positive().optional(),
                  thread_reply: z.boolean().optional(),
                  variant: z.boolean().optional(),
                }),
              )
              .min(1),
          }),
        },
        async (args, ctx) => textResult(await setSequence(await makeCtx("rep"), emailFrom(ctx), args)),
      );

      server.registerTool(
        "set_schedule",
        {
          description: "Set the send window on a campaign you created. Times are HH:MM.",
          inputSchema: z.object({
            campaign_id: z.number().int().positive(),
            monday: z.boolean(),
            tuesday: z.boolean(),
            wednesday: z.boolean(),
            thursday: z.boolean(),
            friday: z.boolean(),
            saturday: z.boolean(),
            sunday: z.boolean(),
            start_time: time,
            end_time: time,
            timezone: z.string().min(1),
          }),
        },
        async (args, ctx) => textResult(await setSchedule(await makeCtx("rep"), emailFrom(ctx), args)),
      );

      server.registerTool(
        "add_leads",
        {
          description:
            "Create or update leads (patch) and attach them to a campaign you created. Personal webmail and corporate domains cannot share a campaign. A mismatch attaches nothing and returns the personal/corporate split so you can create the other campaign. Corporate leads are also refused when any attached sender is SURBL. allow_parallel_sending is always false.",
          inputSchema: z.object({
            campaign_id: z.number().int().positive(),
            leads: z
              .array(
                z.object({
                  email: z.string().email(),
                  first_name: z.string().min(1),
                  last_name: z.string().optional(),
                  company: z.string().optional(),
                  title: z.string().optional(),
                  custom_variables: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
                }),
              )
              .min(1)
              .max(500),
          }),
        },
        async (args, ctx) => textResult(await addLeads(await makeCtx("rep"), emailFrom(ctx), args)),
      );

      server.registerTool(
        "assign_senders",
        {
          description:
            "Attach sender mailboxes you own to a campaign you created. Refuses mailboxes you do not own, any mailbox on exactly usatce.com, and any SURBL mailbox on a corporate campaign. A SURBL mailbox may be used on a personal campaign only.",
          inputSchema: z.object({
            campaign_id: z.number().int().positive(),
            sender_email_ids: z.array(z.number().int().positive()).min(1),
          }),
        },
        async (args, ctx) => textResult(await assignSenders(await makeCtx("rep"), emailFrom(ctx), args)),
      );

      server.registerTool(
        "set_caps",
        {
          description:
            "Set daily caps on a campaign you created. max_new_leads_per_day is clamped to 100 and max_emails_per_day to 250. Corporate campaigns are forced to 3 sends per receiving domain. Personal campaigns leave that cap unset. Plain text stays on, open tracking stays off, and there is no unsubscribe link. This does not change any sender daily_limit.",
          inputSchema: z.object({
            campaign_id: z.number().int().positive(),
            max_emails_per_day: z.number().int().positive(),
            max_new_leads_per_day: z.number().int().positive(),
          }),
        },
        async (args, ctx) => textResult(await setCaps(await makeCtx("rep"), emailFrom(ctx), args)),
      );

      server.registerTool(
        "get_my_campaign",
        {
          description: "Read one campaign you created, including sequence, schedule, senders, and leads.",
          inputSchema: z.object({ campaign_id: z.number().int().positive() }),
        },
        async (args, ctx) => textResult(await getMyCampaign(await makeCtx("rep"), emailFrom(ctx), args.campaign_id)),
      );

      server.registerTool(
        "preflight_check",
        {
          description:
            "Run every deliverability gate for a campaign you created: ownership, paused status, plain text, caps, copy, audience match, SURBL, and sender usage at or under 80% of daily_limit. This does not resume the campaign.",
          inputSchema: z.object({ campaign_id: z.number().int().positive() }),
        },
        async (args, ctx) => textResult(await preflightCheck(await makeCtx("rep"), emailFrom(ctx), args.campaign_id)),
      );

      server.registerTool(
        "request_activation",
        {
          description:
            "Run preflight and, only if it passes, store a pending activation request for the deliverability owner. The campaign stays paused. You cannot approve or resume it.",
          inputSchema: z.object({ campaign_id: z.number().int().positive() }),
        },
        async (args, ctx) =>
          textResult(await requestActivation(await makeCtx("rep"), emailFrom(ctx), args.campaign_id)),
      );

      server.registerTool(
        "list_my_campaigns",
        {
          description:
            "Read-only list of campaigns this rep created. Each row has status, created date, lead count, sent, reply count, bounce count, and the latest activation state. It does not return reply text.",
          inputSchema: z.object({}),
        },
        async (_args, ctx) => textResult(await listMyCampaigns(await makeCtx("rep"), emailFrom(ctx))),
      );

      server.registerTool(
        "get_campaign_stats",
        {
          description:
            "Read-only stats for one campaign this rep created: daily sent and still-scheduled counts, reply, bounce, and interested counts, plus scheduled emails in the next 48 hours. Counts only. No reply text.",
          inputSchema: z.object({ campaign_id: z.number().int().positive() }),
        },
        async (args, ctx) =>
          textResult(await getCampaignStats(await makeCtx("rep"), emailFrom(ctx), args.campaign_id)),
      );

      server.registerTool(
        "get_activation_status",
        {
          description:
            "Read-only activation state for a campaign this rep created: pending, approved, denied, or none. A denial includes the approver's reason. This does not approve or resume.",
          inputSchema: z.object({ campaign_id: z.number().int().positive() }),
        },
        async (args, ctx) =>
          textResult(await getActivationStatus(await makeCtx("rep"), emailFrom(ctx), args.campaign_id)),
      );

      server.registerTool(
        "my_daily_summary",
        {
          description:
            "One read-only morning check-in: this rep's mailboxes and usage, their campaigns with sent, replies, bounces, and activation state, plus what is scheduled in the next 48 hours. No reply text and no changes.",
          inputSchema: z.object({}),
        },
        async (_args, ctx) => textResult(await myDailySummary(await makeCtx("rep"), emailFrom(ctx))),
      );
    },
    {
      serverInfo: { name: "tce-emailbison", version: "1.0.0" },
      instructions:
        "Build paused EmailBison campaigns for the signed-in TCE rep. Never ask for an EmailBison API key. Campaigns stay paused until an admin approves activation outside this connector. Status tools are read-only and return counts, not reply text.",
    },
  );

  return withMcpAuth(
    handler,
    async (_req, bearer) => {
      const db = await getDb();
      return verifyBearer(db, bearer);
    },
    {
      required: true,
      requiredScopes: ["campaigns"],
      resourceMetadataPath: "/.well-known/oauth-protected-resource",
      resourceUrl,
    },
  );
}

export { REP_TOOL_NAMES };

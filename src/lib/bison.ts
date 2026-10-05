import { WORKSPACE_ID } from "./constants";

export class BisonError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

type Actor = "rep" | "admin";

const ALLOWED: { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/api\/users$/ },
  { method: "GET", pattern: /^\/api\/campaigns$/ },
  { method: "POST", pattern: /^\/api\/campaigns$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/campaigns\/\d+\/update$/ },
  { method: "PATCH", pattern: /^\/api\/campaigns\/\d+\/pause$/ },
  { method: "PATCH", pattern: /^\/api\/campaigns\/\d+\/resume$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/schedule$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/\d+\/schedule$/ },
  { method: "PUT", pattern: /^\/api\/campaigns\/\d+\/schedule$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/v1\.1\/\d+\/sequence-steps$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/v1\.1\/\d+\/sequence-steps$/ },
  { method: "PUT", pattern: /^\/api\/campaigns\/v1\.1\/sequence-steps\/\d+$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/\d+\/attach-sender-emails$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/sender-emails$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/leads$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/scheduled-emails$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/line-area-chart-stats$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/\d+\/leads\/attach-leads$/ },
  { method: "GET", pattern: /^\/api\/scheduled-emails$/ },
  { method: "GET", pattern: /^\/api\/sender-emails$/ },
  { method: "POST", pattern: /^\/api\/leads\/create-or-update\/multiple$/ },
  { method: "GET", pattern: /^\/api\/tags$/ },
  { method: "POST", pattern: /^\/api\/tags$/ },
  { method: "POST", pattern: /^\/api\/tags\/attach-to-campaigns$/ },
  { method: "POST", pattern: /^\/api\/tags\/attach-to-sender-emails$/ },
];

export type BisonTag = { id: number; name: string; default?: boolean };
export type BisonSender = {
  id: number;
  name?: string;
  email: string;
  daily_limit?: number | null;
  emails_sent_count?: number | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
  tags?: BisonTag[];
};
export type BisonCampaign = {
  id: number;
  name: string;
  type?: string;
  status?: string;
  plain_text?: boolean;
  open_tracking?: boolean;
  can_unsubscribe?: boolean;
  sequence_prioritization?: string;
  max_emails_per_day?: number | null;
  max_new_leads_per_day?: number | null;
  daily_max_sends_per_receiving_domain?: number | null;
  sequence_id?: number | null;
  tags?: BisonTag[];
  total_leads?: number | null;
  emails_sent?: number | string | null;
  replied?: number | string | null;
  bounced?: number | string | null;
  interested?: number | string | null;
  created_at?: string;
  updated_at?: string;
};
export type BisonLead = {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  custom_variables?: { name: string; value?: string | null }[];
};
export type BisonStep = {
  id?: number;
  email_subject: string;
  email_body: string;
  order?: number;
  wait_in_days?: number;
  variant?: boolean;
  thread_reply?: boolean;
};
export type BisonSchedule = {
  id?: number;
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
};
export type ScheduledEmail = {
  id: number;
  status?: string;
  scheduled_date_local?: string;
  email_subject?: string;
  sender_email?: { id: number };
  sender_email_id?: number;
  campaign_id?: number;
  lead?: { email?: string };
};
export type DailyStat = {
  date: string;
  sent: number;
  replied: number;
  bounced: number;
  interested: number;
};

function listFrom(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  return [];
}

export class BisonClient {
  private workspaceChecked = false;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      actor: Actor;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private allow(method: string, path: string): void {
    const pathname = path.split("?")[0] ?? path;
    if (pathname.includes("daily-limit") || pathname.includes("switch-workspace") || pathname.includes("move-to-another-workspace")) {
      throw new BisonError(
        "path_blocked",
        "This connector cannot change sender limits or touch another workspace.",
      );
    }
    if (pathname.includes("/replies") || pathname.includes("/reply")) {
      throw new BisonError("path_blocked", "This connector does not read or send replies.");
    }
    const ok = ALLOWED.some((rule) => rule.method === method && rule.pattern.test(pathname));
    if (!ok) {
      throw new BisonError("path_blocked", `EmailBison path ${method} ${pathname} is not used by this connector.`);
    }
    if (pathname.endsWith("/resume") && this.options.actor !== "admin") {
      throw new BisonError("rep_cannot_resume", "Reps cannot resume a campaign.");
    }
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    this.allow(method, path);
    if (!this.options.apiKey) {
      throw new BisonError("missing_api_key", "EMAILBISON_API_KEY is not configured.");
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(`${this.options.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      throw new BisonError(
        "bison_http",
        `EmailBison ${method} ${path.split("?")[0]} returned ${response.status}.`,
        response.status,
      );
    }
    return parsed;
  }

  private async assertWorkspace(): Promise<void> {
    if (this.workspaceChecked) return;
    const payload = (await this.request("GET", "/api/users")) as {
      data?: { team?: { id?: number } };
    };
    const teamId = payload?.data?.team?.id;
    if (teamId !== WORKSPACE_ID) {
      throw new BisonError(
        "workspace_mismatch",
        `The EmailBison key is in workspace ${String(teamId)}, not workspace ${WORKSPACE_ID}. No further calls were made.`,
      );
    }
    this.workspaceChecked = true;
  }

  private async authed(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.assertWorkspace();
    return this.request(method, path, body);
  }
  private async list(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = path;
    for (let page = 0; page < 20 && next; page += 1) {
      const payload = (await this.authed("GET", next)) as {
        data?: unknown;
        links?: { next?: string | null };
      };
      items.push(...listFrom(payload));
      const link = payload?.links?.next;
      if (!link) break;
      const base = new URL(this.options.baseUrl);
      const target = new URL(link, this.options.baseUrl);
      if (target.origin !== base.origin) break;
      next = `${target.pathname}${target.search}`;
    }
    return items;
  }

  async listSenders(): Promise<BisonSender[]> {
    return (await this.list("/api/sender-emails")) as BisonSender[];
  }

  async listCampaigns(): Promise<BisonCampaign[]> {
    return (await this.list("/api/campaigns")) as BisonCampaign[];
  }

  async createCampaign(name: string): Promise<BisonCampaign> {
    const payload = (await this.authed("POST", "/api/campaigns", {
      name,
      type: "outbound",
    })) as { data: BisonCampaign };
    return payload.data;
  }

  async updateCampaign(id: number, body: Record<string, unknown>): Promise<BisonCampaign> {
    const payload = (await this.authed("PATCH", `/api/campaigns/${id}/update`, body)) as {
      data: BisonCampaign;
    };
    return payload.data;
  }

  async pauseCampaign(id: number): Promise<BisonCampaign> {
    const payload = (await this.authed("PATCH", `/api/campaigns/${id}/pause`)) as {
      data: BisonCampaign;
    };
    return payload.data;
  }

  async resumeCampaign(id: number): Promise<BisonCampaign> {
    const payload = (await this.authed("PATCH", `/api/campaigns/${id}/resume`)) as {
      data: BisonCampaign;
    };
    return payload.data;
  }

  async getCampaign(id: number): Promise<BisonCampaign> {
    const payload = (await this.authed("GET", `/api/campaigns/${id}`)) as { data: BisonCampaign };
    return payload.data;
  }

  async getSchedule(id: number): Promise<BisonSchedule | null> {
    try {
      const payload = (await this.authed("GET", `/api/campaigns/${id}/schedule`)) as {
        data?: BisonSchedule | null;
      };
      return payload.data ?? null;
    } catch (error) {
      if (error instanceof BisonError && error.status === 404) return null;
      throw error;
    }
  }

  async saveSchedule(id: number, schedule: BisonSchedule, exists: boolean): Promise<BisonSchedule> {
    const body = { ...schedule, save_as_template: false };
    const payload = (await this.authed(
      exists ? "PUT" : "POST",
      `/api/campaigns/${id}/schedule`,
      body,
    )) as { data: BisonSchedule };
    return payload.data;
  }

  async getSequence(campaignId: number): Promise<{ sequence_id: number | null; sequence_steps: BisonStep[] }> {
    try {
      const payload = (await this.authed(
        "GET",
        `/api/campaigns/v1.1/${campaignId}/sequence-steps`,
      )) as { data?: { sequence_id?: number; sequence_steps?: BisonStep[] } };
      return {
        sequence_id: payload.data?.sequence_id ?? null,
        sequence_steps: payload.data?.sequence_steps ?? [],
      };
    } catch (error) {
      if (error instanceof BisonError && error.status === 404) {
        return { sequence_id: null, sequence_steps: [] };
      }
      throw error;
    }
  }

  async createSequence(
    campaignId: number,
    title: string,
    steps: BisonStep[],
  ): Promise<{ id: number; sequence_steps: BisonStep[] }> {
    const payload = (await this.authed("POST", `/api/campaigns/v1.1/${campaignId}/sequence-steps`, {
      title,
      sequence_steps: steps,
    })) as { data: { id: number; sequence_steps: BisonStep[] } };
    return payload.data;
  }

  async updateSequence(
    sequenceId: number,
    title: string,
    steps: BisonStep[],
  ): Promise<{ id: number; sequence_steps: BisonStep[] }> {
    const payload = (await this.authed("PUT", `/api/campaigns/v1.1/sequence-steps/${sequenceId}`, {
      title,
      sequence_steps: steps,
    })) as { data: { id: number; sequence_steps: BisonStep[] } };
    return payload.data;
  }

  async attachSenders(campaignId: number, senderIds: number[]): Promise<void> {
    await this.authed("POST", `/api/campaigns/${campaignId}/attach-sender-emails`, {
      sender_email_ids: senderIds,
    });
  }

  async campaignSenders(campaignId: number): Promise<BisonSender[]> {
    return (await this.list(`/api/campaigns/${campaignId}/sender-emails`)) as BisonSender[];
  }

  async campaignLeads(campaignId: number): Promise<BisonLead[]> {
    return (await this.list(`/api/campaigns/${campaignId}/leads`)) as BisonLead[];
  }

  async campaignScheduled(campaignId: number): Promise<ScheduledEmail[]> {
    return (await this.list(`/api/campaigns/${campaignId}/scheduled-emails`)) as ScheduledEmail[];
  }

  async chartStats(campaignId: number, startDate: string, endDate: string): Promise<DailyStat[]> {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    const payload = (await this.authed(
      "GET",
      `/api/campaigns/${campaignId}/line-area-chart-stats?${params.toString()}`,
    )) as { data?: { label?: string; dates?: unknown[] }[] };
    const byDate = new Map<string, DailyStat>();
    const labelKey = (label: string): keyof Omit<DailyStat, "date"> | null => {
      const name = label.trim().toLowerCase();
      if (name === "sent") return "sent";
      if (name === "replied") return "replied";
      if (name === "bounced") return "bounced";
      if (name === "interested") return "interested";
      return null;
    };
    for (const series of payload.data ?? []) {
      const key = labelKey(series.label ?? "");
      if (!key) continue;
      for (const point of series.dates ?? []) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const date = String(point[0]);
        const count = Number(point[1]);
        const row = byDate.get(date) ?? { date, sent: 0, replied: 0, bounced: 0, interested: 0 };
        row[key] = Number.isFinite(count) ? count : 0;
        byDate.set(date, row);
      }
    }
    return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  async listScheduled(query: {
    senderId?: number;
    localDate?: string;
  }): Promise<ScheduledEmail[]> {
    const params = new URLSearchParams();
    if (query.senderId != null) params.set("sender_email_ids", String(query.senderId));
    if (query.localDate) {
      params.set("scheduled_date_local.value", query.localDate);
      params.set("scheduled_date_local.criteria", "=");
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return (await this.list(`/api/scheduled-emails${suffix}`)) as ScheduledEmail[];
  }

  async upsertLeads(
    leads: {
      email: string;
      first_name: string;
      last_name?: string;
      company?: string;
      title?: string;
      custom_variables?: { name: string; value: string }[];
    }[],
  ): Promise<BisonLead[]> {
    const created: BisonLead[] = [];
    for (let i = 0; i < leads.length; i += 500) {
      const chunk = leads.slice(i, i + 500);
      const payload = (await this.authed("POST", "/api/leads/create-or-update/multiple", {
        existing_lead_behavior: "patch",
        leads: chunk,
      })) as { data: BisonLead[] };
      created.push(...payload.data);
    }
    return created;
  }

  async attachLeads(campaignId: number, leadIds: number[]): Promise<void> {
    await this.authed("POST", `/api/campaigns/${campaignId}/leads/attach-leads`, {
      lead_ids: leadIds,
      allow_parallel_sending: false,
    });
  }

  async listTags(): Promise<BisonTag[]> {
    return (await this.list("/api/tags")) as BisonTag[];
  }

  async ensureTag(name: string): Promise<number> {
    const tags = await this.listTags();
    const found = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const payload = (await this.authed("POST", "/api/tags", { name })) as { data: BisonTag };
    return payload.data.id;
  }

  async attachTagToCampaigns(tagId: number, campaignIds: number[]): Promise<void> {
    await this.authed("POST", "/api/tags/attach-to-campaigns", {
      tag_ids: [tagId],
      campaign_ids: campaignIds,
    });
  }

  async attachTagToSenders(tagId: number, senderIds: number[]): Promise<void> {
    await this.authed("POST", "/api/tags/attach-to-sender-emails", {
      tag_ids: [tagId],
      sender_email_ids: senderIds,
    });
  }
}


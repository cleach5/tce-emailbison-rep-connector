import { createHash } from "node:crypto";

export type CopyStep = {
  email_subject: string;
  email_body: string;
  order?: number;
  variant?: boolean;
};

export type RenderLead = {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  custom_variables?: { name: string; value?: string | null }[] | null;
};

export type CopyViolation = {
  code: "banned_phrase" | "do_not_mention" | "repeated_sentence" | "repeated_body";
  message: string;
  phrase?: string;
  count?: number;
  step_order?: number;
};

const BANNED: { phrase: string; label: string }[] = [
  { phrase: "confidential", label: "confidential" },
  { phrase: "compliance", label: "compliance" },
  { phrase: "general perspective", label: "general perspective" },
];

const RATE_PATTERNS: RegExp[] = [
  /\$\s?\d[\d,]*(?:\.\d+)?/,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:\/|per|an)\s*(?:hr|hour|hours)\b/i,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:usd|dollars)\b/i,
  /\b(?:usd|dollars)\s*\d/i,
];

const DASH = /[\u2013\u2014]/;

function hash(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0);
}

function variableMap(lead: RenderLead): Map<string, string> {
  const map = new Map<string, string>();
  const put = (key: string, value: string) => {
    map.set(key.toUpperCase(), value);
    map.set(key.toUpperCase().replace(/\s+/g, "_"), value);
  };
  put("FIRST_NAME", lead.first_name ?? "");
  put("LAST_NAME", lead.last_name ?? "");
  put("EMAIL", lead.email ?? "");
  put("COMPANY", lead.company ?? "");
  put("TITLE", lead.title ?? "");
  for (const variable of lead.custom_variables ?? []) {
    put(variable.name, variable.value ?? "");
  }
  return map;
}

/** Substitute `{VARS}` and `{a|b}` spintax. Choices are stable for a lead and step. */
export function renderCopy(template: string, lead: RenderLead, seed: string): string {
  const vars = variableMap(lead);
  let text = template;
  for (let i = 0; i < 30; i += 1) {
    let replaced = false;
    text = text.replace(/\{([^{}]+)\}/, (match, inner: string, offset: number) => {
      replaced = true;
      if (inner.includes("|")) {
        const options = inner.split("|");
        const index = hash(`${seed}:${offset}:${inner}`) % options.length;
        return options[index] ?? "";
      }
      const key = inner.trim().toUpperCase();
      const underscored = key.replace(/\s+/g, "_");
      if (vars.has(key)) return vars.get(key) ?? "";
      if (vars.has(underscored)) return vars.get(underscored) ?? "";
      return "";
    });
    if (!replaced) break;
  }
  return text;
}

function normalizeForPhrases(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSentence(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentences(value: string): string[] {
  return value
    .split(/[.!?]+/u)
    .map(normalizeSentence)
    .filter((sentence) => sentence.length >= 3);
}

function bodyKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function scanText(
  text: string,
  doNotMention: string[],
  where: string,
): CopyViolation[] {
  const violations: CopyViolation[] = [];
  if (DASH.test(text)) {
    violations.push({
      code: "banned_phrase",
      phrase: "em_or_en_dash",
      message: `${where} contains an em dash or en dash.`,
    });
  }
  const normalized = normalizeForPhrases(text);
  for (const banned of BANNED) {
    if (normalized.includes(banned.phrase)) {
      violations.push({
        code: "banned_phrase",
        phrase: banned.label,
        message: `${where} contains the banned phrase "${banned.label}".`,
      });
    }
  }
  for (const pattern of RATE_PATTERNS) {
    if (pattern.test(text) || pattern.test(normalized)) {
      violations.push({
        code: "banned_phrase",
        phrase: "dollar_or_hourly_rate",
        message: `${where} contains a dollar amount or an hourly rate.`,
      });
      break;
    }
  }
  for (const name of doNotMention) {
    const needle = normalizeForPhrases(name);
    if (needle.length >= 2 && normalized.includes(needle)) {
      violations.push({
        code: "do_not_mention",
        phrase: name,
        message: `${where} mentions "${name}", which is on this campaign's do-not-mention list.`,
      });
    }
  }
  return violations;
}

function groupSteps(steps: CopyStep[]): CopyStep[][] {
  const groups = new Map<number, CopyStep[]>();
  steps.forEach((step, index) => {
    const order = step.order ?? index + 1;
    const list = groups.get(order) ?? [];
    list.push(step);
    groups.set(order, list);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => group);
}

/**
 * Copy gate used by set_sequence and preflight.
 * Templates are scanned even when no lead is attached, including text that
 * sits inside an unselected spintax branch. When leads exist, each lead and
 * each sequence step is one send: a normalized sentence or a rendered body
 * may appear in at most 5 sends.
 */
export function checkCopy(
  steps: CopyStep[],
  leads: RenderLead[],
  doNotMention: string[],
): CopyViolation[] {
  const violations: CopyViolation[] = [];
  steps.forEach((step, index) => {
    const where = `Step ${step.order ?? index + 1}`;
    violations.push(...scanText(`${step.email_subject}\n${step.email_body}`, doNotMention, where));
  });

  const sentenceCounts = new Map<string, number>();
  const bodyCounts = new Map<string, number>();
  const groups = groupSteps(steps);

  for (const lead of leads) {
    groups.forEach((group, groupIndex) => {
      const chosen =
        group[
          hash(`${lead.email}:order:${groupIndex}`) % group.length
        ] ?? group[0];
      if (!chosen) return;
      const rendered = renderCopy(
        `${chosen.email_subject}\n${chosen.email_body}`,
        lead,
        `${lead.email}:${groupIndex}`,
      );
      violations.push(
        ...scanText(rendered, doNotMention, `Rendered step ${groupIndex + 1} for ${lead.email}`),
      );
      const body = bodyKey(renderCopy(chosen.email_body, lead, `${lead.email}:${groupIndex}:body`));
      if (body) bodyCounts.set(body, (bodyCounts.get(body) ?? 0) + 1);
      const seenInSend = new Set<string>();
      for (const sentence of sentences(rendered)) {
        if (seenInSend.has(sentence)) continue;
        seenInSend.add(sentence);
        sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
      }
    });
  }

  for (const [sentence, count] of sentenceCounts) {
    if (count > 5) {
      violations.push({
        code: "repeated_sentence",
        count,
        message: `A normalized sentence repeats across ${count} sends (limit is 5): "${sentence.slice(0, 140)}"`,
      });
    }
  }
  for (const [body, count] of bodyCounts) {
    if (count > 5) {
      violations.push({
        code: "repeated_body",
        count,
        message: `A rendered email body repeats across ${count} sends (limit is 5).`,
        phrase: body.slice(0, 140),
      });
    }
  }

  return dedupe(violations);
}

function dedupe(violations: CopyViolation[]): CopyViolation[] {
  const seen = new Set<string>();
  const unique: CopyViolation[] = [];
  for (const violation of violations) {
    const key = `${violation.code}|${violation.phrase ?? ""}|${violation.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(violation);
  }
  return unique;
}

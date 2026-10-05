import {
  BLOCKED_SENDER_DOMAIN,
  SURBL_FAIL_CLOSED_BEFORE,
  SURBL_SYNC_MAX_MS,
  SURBL_TAG,
} from "./constants";
import { emailDomain } from "./webmail";

export function syncIsFresh(syncedAt: Date | null, now: Date): boolean {
  if (!syncedAt) return false;
  return now.getTime() - syncedAt.getTime() <= SURBL_SYNC_MAX_MS;
}

export function asDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Fail closed when the nightly SURBL sync is missing or older than 48 hours.
 * A non-usatce.com domain is treated as SURBL when the earlier of the sender's
 * created_at and the domain's first-seen date is before 2026-10-01.
 * Unknown dates are treated as SURBL.
 */
export function failClosedSurbl(
  senderCreatedAt: Date | null,
  domainFirstSeen: Date | null,
): boolean {
  const stamps = [senderCreatedAt, domainFirstSeen].filter(
    (value): value is Date => value != null,
  );
  if (stamps.length === 0) return true;
  const earliest = Math.min(...stamps.map((value) => value.getTime()));
  return earliest < new Date(SURBL_FAIL_CLOSED_BEFORE).getTime();
}

export function hasSurblTag(tags: { name?: string | null }[] | null | undefined): boolean {
  return (tags ?? []).some((tag) => (tag.name ?? "").trim().toLowerCase() === SURBL_TAG);
}

export function senderIsSurbl(input: {
  email: string;
  tags?: { name?: string | null }[] | null;
  createdAt: Date | null;
  domainFirstSeen: Date | null;
  syncedAt: Date | null;
  now: Date;
}): { surbl: boolean; reason: "tag" | "fail_closed" | "clear"; failClosed: boolean } {
  const domain = emailDomain(input.email);
  if (domain === BLOCKED_SENDER_DOMAIN) {
    return { surbl: false, reason: "clear", failClosed: !syncIsFresh(input.syncedAt, input.now) };
  }
  const tagged = hasSurblTag(input.tags);
  const failClosed = !syncIsFresh(input.syncedAt, input.now);
  if (!failClosed) {
    return { surbl: tagged, reason: tagged ? "tag" : "clear", failClosed };
  }
  if (tagged) return { surbl: true, reason: "tag", failClosed };
  const aged = failClosedSurbl(input.createdAt, input.domainFirstSeen);
  return { surbl: aged, reason: aged ? "fail_closed" : "clear", failClosed };
}

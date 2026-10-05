/**
 * Personal webmail and consumer ISP domains.
 * A lead is personal when its domain is in this set, and corporate otherwise.
 * Match is exact (lowercase), not a substring of the domain.
 */
export const WEBMAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.fr",
  "yahoo.de",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "outlook.co.uk",
  "outlook.fr",
  "outlook.de",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "live.com",
  "live.co.uk",
  "live.fr",
  "msn.com",
  "aol.com",
  "aim.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "comcast.net",
  "xfinity.com",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "pacbell.net",
  "prodigy.net",
  "currently.com",
  "verizon.net",
  "cox.net",
  "charter.net",
  "spectrum.net",
  "earthlink.net",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
  "yandex.com",
  "yandex.ru",
  "naver.com",
  "web.de",
  "orange.fr",
  "wanadoo.fr",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "rogers.com",
  "shaw.ca",
  "bell.net",
  "telus.net",
  "optusnet.com.au",
  "bigpond.com",
  "bigpond.net.au",
  "t-online.de",
  "freenet.de",
  "laposte.net",
  "free.fr",
  "sfr.fr",
  "libero.it",
  "alice.it",
  "uol.com.br",
  "bol.com.br",
  "rediffmail.com",
  "mail.ru",
  "inbox.com",
  "lycos.com",
  "juno.com",
  "netzero.net",
  "frontier.com",
  "frontiernet.net",
  "windstream.net",
  "centurylink.net",
  "q.com",
  "optonline.net",
  "rcn.com",
  "twc.com",
  "rr.com",
];

const WEBMAIL = new Set(WEBMAIL_DOMAINS);

export type Audience = "personal" | "corporate";

export function emailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "";
  return trimmed.slice(at + 1);
}

export function classifyEmail(email: string): Audience | "invalid" {
  const domain = emailDomain(email);
  if (!domain || domain.includes(" ") || !domain.includes(".")) return "invalid";
  return WEBMAIL.has(domain) ? "personal" : "corporate";
}

export function isBlockedSenderDomain(email: string): boolean {
  return emailDomain(email) === "usatce.com";
}

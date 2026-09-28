import { addDays, daysBetween, type IsoDate } from "./dates";

export const LEAD_SOURCES = ["facebook_page", "messenger", "fb_lead_ad", "landing_page", "referral", "walk_in", "tiktok", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABELS: Record<LeadSource, string> = {
  facebook_page: "Facebook page",
  messenger: "Messenger",
  fb_lead_ad: "FB Lead Ad",
  landing_page: "Website form",
  referral: "Referral",
  walk_in: "Walk-in",
  tiktok: "TikTok",
  other: "Other",
};

export const SERVICE_LINES = ["franchise", "activation", "vehicle_program", "fleet", "investment", "school", "other"] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];

export const SERVICE_LINE_LABELS: Record<ServiceLine, string> = {
  franchise: "TNVS franchise (LTFRB PA/CPC)",
  activation: "Platform activation & onboarding",
  vehicle_program: "Vehicle programs (boundary / rent-to-own)",
  fleet: "Fleet management & partnerships",
  investment: "Investing in units",
  school: "Driver school",
  other: "Something else",
};

export const CONTACT_METHODS = ["call", "sms", "messenger", "viber", "email"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];
export const CONTACT_LABELS: Record<ContactMethod, string> = {
  call: "Call",
  sms: "Text (SMS)",
  messenger: "Messenger",
  viber: "Viber",
  email: "Email",
};

/**
 * Normalises a Philippine mobile number for storage and duplicate detection.
 * Anything that isn't a PH mobile is kept as typed (trimmed) with no E.164 form.
 */
export function normalizeMobile(input: string): { mobile: string; e164: string | null } {
  const raw = input.trim();
  const digits = raw.replace(/[^\d]/g, "");
  let local: string | null = null;
  if (/^09\d{9}$/.test(digits)) local = digits;
  else if (/^639\d{9}$/.test(digits)) local = `0${digits.slice(2)}`;
  else if (/^9\d{9}$/.test(digits)) local = `0${digits}`;
  return local ? { mobile: local, e164: `+63${local.slice(1)}` } : { mobile: raw, e164: null };
}

export type FollowupBucket = "overdue" | "today" | "soon" | "later";

/** Where a follow-up sits in an agent's task list. */
export function followupBucket(dueOn: IsoDate, today: IsoDate): FollowupBucket {
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "today";
  return dueOn <= addDays(today, 7) ? "soon" : "later";
}

/** Days a lead has been waiting since it was created (for "age" on the board). */
export function leadAgeDays(createdOn: IsoDate, today: IsoDate): number {
  return Math.max(0, daysBetween(createdOn, today));
}

/**
 * Picks the agent for a new lead: fewest open leads first, then the one who
 * received a lead least recently, then by id (stable). Null when no agents.
 */
export function pickAgent(agents: readonly { id: string; openLeads: number; lastAssignedAt: number | null }[]): string | null {
  if (agents.length === 0) return null;
  const sorted = [...agents].sort(
    (a, b) => a.openLeads - b.openLeads || (a.lastAssignedAt ?? 0) - (b.lastAssignedAt ?? 0) || a.id.localeCompare(b.id),
  );
  return sorted[0].id;
}

const SOURCE_ALIASES: Record<string, LeadSource> = {
  facebook: "facebook_page",
  fb: "facebook_page",
  "facebook page": "facebook_page",
  messenger: "messenger",
  "fb lead ad": "fb_lead_ad",
  "lead ad": "fb_lead_ad",
  website: "landing_page",
  "landing page": "landing_page",
  referral: "referral",
  "walk-in": "walk_in",
  "walk in": "walk_in",
  walkin: "walk_in",
  tiktok: "tiktok",
};

export function parseLeadSource(s: string): LeadSource | null {
  const k = s.trim().toLowerCase().replace(/_/g, " ");
  if (!k) return "other";
  if ((LEAD_SOURCES as readonly string[]).includes(k.replace(/ /g, "_"))) return k.replace(/ /g, "_") as LeadSource;
  return SOURCE_ALIASES[k] ?? (k === "other" ? "other" : null);
}

export function parseServiceLine(s: string): ServiceLine | null {
  const k = s.trim().toLowerCase();
  if (!k) return "other";
  if ((SERVICE_LINES as readonly string[]).includes(k.replace(/[\s-]+/g, "_"))) return k.replace(/[\s-]+/g, "_") as ServiceLine;
  if (/franchise|ltfrb|cpc|\bpa\b/.test(k)) return "franchise";
  if (/activation|onboard|indrive|platform/.test(k)) return "activation";
  if (/boundary|hulog|rent|rto|unit|vehicle/.test(k)) return "vehicle_program";
  if (/fleet|partner|dealer/.test(k)) return "fleet";
  if (/invest/.test(k)) return "investment";
  if (/school|training|course/.test(k)) return "school";
  return null;
}

export type LeadImportRow = {
  line: number;
  name: string;
  mobile: string;
  e164: string | null;
  email: string | null;
  fbName: string;
  source: LeadSource;
  interest: ServiceLine;
  location: string;
  notes: string;
  error?: string;
};

/**
 * Validates CSV rows (already parsed to objects keyed by normalised header).
 * Accepted headers: name, mobile/phone, email, facebook/fb_name, source, interest/service, location/city, notes/message.
 */
export function validateLeadRows(rows: readonly Record<string, string>[]): LeadImportRow[] {
  const pick = (r: Record<string, string>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v.trim() !== "")?.trim() ?? "";
  return rows.map((r, i) => {
    const name = pick(r, "name", "full_name", "fullname");
    const phone = normalizeMobile(pick(r, "mobile", "mobile_number", "phone", "phone_number", "contact", "contact_number"));
    const email = pick(r, "email", "email_address") || null;
    const fbName = pick(r, "facebook", "fb_name", "facebook_name", "messenger");
    const source = parseLeadSource(pick(r, "source"));
    const interest = parseServiceLine(pick(r, "interest", "service", "service_interested_in"));
    const row: LeadImportRow = {
      line: i + 2,
      name,
      mobile: phone.mobile,
      e164: phone.e164,
      email,
      fbName,
      source: source ?? "other",
      interest: interest ?? "other",
      location: pick(r, "location", "city", "address"),
      notes: pick(r, "notes", "message", "remarks"),
    };
    if (!name) row.error = "Name is required.";
    else if (!phone.mobile && !email && !fbName) row.error = "Give a mobile number, email or Facebook name.";
    else if (phone.mobile && !phone.e164) row.error = `"${phone.mobile}" is not a PH mobile number.`;
    else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) row.error = `"${email}" is not a valid email.`;
    else if (source === null) row.error = `Unknown source "${pick(r, "source")}".`;
    else if (interest === null) row.error = `Unknown interest "${pick(r, "interest", "service", "service_interested_in")}".`;
    return row;
  });
}

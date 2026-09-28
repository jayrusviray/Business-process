import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeMobile } from "./crm";

/** Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex HMAC of the raw body>"). */
export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex"), "utf8");
  const given = Buffer.from(header.slice(7), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type LeadgenChange = { leadgenId: string; pageId: string | null; formId: string | null };

/** Extracts Lead Ads events from a Page webhook payload; ignores everything else. */
export function parseLeadgenChanges(payload: unknown): LeadgenChange[] {
  const out: LeadgenChange[] = [];
  if (!payload || typeof payload !== "object" || (payload as { object?: unknown }).object !== "page") return out;
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      const ch = c as { field?: unknown; value?: { leadgen_id?: unknown; page_id?: unknown; form_id?: unknown } };
      if (ch?.field !== "leadgen" || ch.value?.leadgen_id === undefined) continue;
      out.push({
        leadgenId: String(ch.value.leadgen_id),
        pageId: ch.value.page_id !== undefined ? String(ch.value.page_id) : null,
        formId: ch.value.form_id !== undefined ? String(ch.value.form_id) : null,
      });
    }
  }
  return out;
}

export type MappedLead = { name: string; mobile: string; e164: string | null; email: string | null; location: string; extra: string };

/** Maps Lead Ads `field_data` ([{ name, values: [] }]) to lead fields. Unknown fields go to `extra`. */
export function mapLeadFields(fieldData: unknown): MappedLead {
  const fields = new Map<string, string>();
  if (Array.isArray(fieldData)) {
    for (const f of fieldData) {
      const name = typeof f?.name === "string" ? f.name.toLowerCase() : "";
      const value = Array.isArray(f?.values) ? f.values.map(String).join(", ").trim() : "";
      if (name && value) fields.set(name, value);
    }
  }
  const take = (...keys: string[]) => {
    for (const k of keys) {
      const v = fields.get(k);
      if (v) {
        fields.delete(k);
        return v;
      }
    }
    return "";
  };
  const first = take("first_name");
  const last = take("last_name");
  const name = take("full_name", "name") || [first, last].filter(Boolean).join(" ");
  const phone = normalizeMobile(take("phone_number", "phone", "mobile_number"));
  const email = take("email") || null;
  const location = take("city", "location", "province", "state");
  const extra = [...fields.entries()].map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n");
  return { name: name || "Facebook lead", mobile: phone.mobile, e164: phone.e164, email, location, extra };
}

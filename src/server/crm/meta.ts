import "server-only";
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { leadActivities } from "@/db/schema";
import { parseServiceLine } from "@/lib/crm";
import { mapLeadFields, type MappedLead } from "@/lib/meta-leads";
import { createLead, findOpenLeadByMobile, notifyUsers } from "./leads";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Fetches one Lead Ads submission from the Graph API (needs a page access token with leads_retrieval). */
export async function fetchLeadgen(leadgenId: string, pageToken: string): Promise<{ mapped: MappedLead; createdTime: Date | null }> {
  const url = `${GRAPH}/${encodeURIComponent(leadgenId)}?fields=created_time,field_data&access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`Graph API ${res.status} for lead ${leadgenId}`);
  const body = (await res.json()) as { created_time?: string; field_data?: unknown };
  return { mapped: mapLeadFields(body.field_data), createdTime: body.created_time ? new Date(body.created_time) : null };
}

/**
 * Stores a Facebook Lead Ads submission once (idempotent on the leadgen id):
 * a new lead (source "FB Lead Ad"), or a timeline entry on the person's open lead.
 */
export async function ingestFacebookLead(tx: Tx, input: { leadgenId: string; mapped: MappedLead; createdTime: Date | null }): Promise<"created" | "merged" | "duplicate"> {
  const ref = `fb:${input.leadgenId}`;
  const [seen] = await tx.execute(sql`
    SELECT 1 FROM public.leads WHERE external_ref = ${ref}
    UNION ALL SELECT 1 FROM public.lead_activities WHERE meta ->> 'externalRef' = ${ref}
    LIMIT 1`);
  if (seen) return "duplicate";
  const m = input.mapped;
  const interest = parseServiceLine(m.extra) ?? "other";
  const open = await findOpenLeadByMobile(tx, m.e164);
  if (open) {
    await tx.insert(leadActivities).values({
      leadId: open.id,
      kind: "inquiry",
      body: ["New Facebook Lead Ad submission", m.extra].filter(Boolean).join("\n"),
      meta: { externalRef: ref, email: m.email, location: m.location },
    });
    await notifyUsers(tx, [open.assigned_to], { title: `${open.name} submitted a Facebook lead form`, link: `/app/crm/${open.id}` });
    return "merged";
  }
  await createLead(tx, {
    name: m.name,
    mobile: m.mobile,
    email: m.email,
    source: "fb_lead_ad",
    interest,
    location: m.location,
    message: m.extra,
    externalRef: ref,
    consentAt: input.createdTime ?? new Date(),
  });
  return "created";
}

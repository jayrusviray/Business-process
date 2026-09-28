import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { leadActivities, leadFollowups, leads, leadStages, notifications, privacyRequests } from "@/db/schema";
import { parseCsvObjects } from "@/lib/csv";
import { normalizeMobile, pickAgent, validateLeadRows, type ContactMethod, type LeadImportRow, type LeadSource, type ServiceLine } from "@/lib/crm";
import type { IsoDate } from "@/lib/dates";
import { MoneyRuleError } from "../money/errors";

export type NewLead = {
  name: string;
  mobile?: string;
  email?: string | null;
  fbName?: string;
  source: LeadSource;
  interest: ServiceLine;
  location?: string;
  preferredContact?: ContactMethod | null;
  message?: string;
  referrerName?: string;
  referrerPhone?: string;
  referrerDriverId?: string | null;
  consentAt?: Date | null;
  externalRef?: string | null;
  notes?: string;
  /** undefined = assign automatically to the least-busy sales agent; null = leave unassigned. */
  assignedTo?: string | null;
};

type OpenLead = { id: string; name: string; assigned_to: string | null };

/** The most recent open lead with this mobile number (duplicate detection). */
export async function findOpenLeadByMobile(tx: Tx, e164: string | null): Promise<OpenLead | null> {
  if (!e164) return null;
  const [row] = await tx.execute<OpenLead>(sql`
    SELECT l.id, l.name, l.assigned_to FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key
    WHERE l.mobile_e164 = ${e164} AND s.kind = 'open'
    ORDER BY l.created_at DESC LIMIT 1`);
  return row ?? null;
}

/** Any lead (open or closed) with this mobile, for warnings on manual entry. */
export async function findLeadsByMobile(tx: Tx, e164: string | null): Promise<{ id: string; name: string; stage: string }[]> {
  if (!e164) return [];
  return tx.execute(sql`
    SELECT l.id, l.name, s.label AS stage FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key
    WHERE l.mobile_e164 = ${e164} ORDER BY l.created_at DESC LIMIT 5`);
}

/** Least-busy active sales agent, or null when there are none. */
export async function autoAssignee(tx: Tx): Promise<string | null> {
  const rows = await tx.execute<{ id: string; open_leads: number; last_assigned_at: Date | string | null }>(
    sql`SELECT id, open_leads, last_assigned_at FROM app.lead_agent_load()`,
  );
  return pickAgent(rows.map((r) => ({ id: r.id, openLeads: r.open_leads, lastAssignedAt: r.last_assigned_at ? new Date(r.last_assigned_at).getTime() : null })));
}

/** In-app notification for each user (duplicates removed). */
export async function notifyUsers(tx: Tx, userIds: readonly (string | null | undefined)[], n: { title: string; body?: string; link?: string }): Promise<void> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  await tx.insert(notifications).values(ids.map((userId) => ({ userId, title: n.title.slice(0, 200), body: (n.body ?? "").slice(0, 1000), link: n.link ?? null })));
}

/** The assignee, or every active owner/admin and sales agent when nobody is assigned. */
async function leadRecipients(tx: Tx, assignedTo: string | null): Promise<string[]> {
  if (assignedTo) return [assignedTo];
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM app.user_ids_with_roles('owner_admin', 'sales') AS id`);
  return rows.map((r) => r.id);
}

export async function createLead(tx: Tx, input: NewLead): Promise<{ id: string; assignedTo: string | null }> {
  const name = input.name.trim();
  if (!name) throw new MoneyRuleError("Enter the lead's name.");
  const phone = normalizeMobile(input.mobile ?? "");
  const email = input.email?.trim() || null;
  const fbName = input.fbName?.trim() ?? "";
  if (!phone.mobile && !email && !fbName) throw new MoneyRuleError("Give a mobile number, email or Facebook name.");
  const assignedTo = input.assignedTo === undefined ? await autoAssignee(tx) : input.assignedTo;
  const [lead] = await tx
    .insert(leads)
    .values({
      name: name.slice(0, 120),
      mobile: phone.mobile,
      mobileE164: phone.e164,
      email,
      fbName: fbName.slice(0, 120),
      source: input.source,
      interest: input.interest,
      location: input.location?.trim().slice(0, 120) ?? "",
      preferredContact: input.preferredContact ?? null,
      message: input.message?.trim().slice(0, 2000) ?? "",
      referrerName: input.referrerName?.trim() ?? "",
      referrerPhone: input.referrerPhone?.trim() ?? "",
      referrerDriverId: input.referrerDriverId ?? null,
      consentAt: input.consentAt ?? null,
      externalRef: input.externalRef ?? null,
      notes: input.notes?.trim() ?? "",
      assignedTo,
    })
    .returning({ id: leads.id });
  if (input.message?.trim()) {
    await tx.insert(leadActivities).values({ leadId: lead.id, kind: "inquiry", body: input.message.trim().slice(0, 2000) });
  }
  await notifyUsers(tx, await leadRecipients(tx, assignedTo), {
    title: `New lead: ${name}`,
    body: `${input.message?.trim().slice(0, 200) ?? ""}`,
    link: `/app/crm/${lead.id}`,
  });
  return { id: lead.id, assignedTo };
}

/**
 * A new inquiry from someone who may already be a lead: added to their open
 * lead's timeline (and the agent is told), or a new lead is created.
 */
export async function recordInquiry(tx: Tx, input: NewLead): Promise<{ leadId: string; duplicate: boolean }> {
  const phone = normalizeMobile(input.mobile ?? "");
  const existing = await findOpenLeadByMobile(tx, phone.e164);
  if (!existing) {
    const created = await createLead(tx, input);
    return { leadId: created.id, duplicate: false };
  }
  await tx.insert(leadActivities).values({
    leadId: existing.id,
    kind: "inquiry",
    body: [`New ${input.source === "landing_page" ? "website" : input.source.replace("_", " ")} inquiry`, input.message?.trim()].filter(Boolean).join(": ").slice(0, 2000),
    meta: { source: input.source, interest: input.interest, name: input.name.trim(), email: input.email ?? null },
  });
  if (input.consentAt) await tx.update(leads).set({ consentAt: input.consentAt }).where(and(eq(leads.id, existing.id), isNull(leads.consentAt)));
  await notifyUsers(tx, await leadRecipients(tx, existing.assigned_to), {
    title: `${existing.name} inquired again`,
    body: input.message?.trim().slice(0, 200) ?? "",
    link: `/app/crm/${existing.id}`,
  });
  return { leadId: existing.id, duplicate: true };
}

export async function addLeadNote(tx: Tx, input: { leadId: string; kind: "note" | "call" | "message"; body: string }): Promise<void> {
  if (!input.body.trim()) throw new MoneyRuleError("Write something first.");
  await tx.insert(leadActivities).values({ leadId: input.leadId, kind: input.kind, body: input.body.trim().slice(0, 2000) });
}

/** Moves a lead to a stage. Losing a lead needs a reason; the timeline entry is written by a trigger. */
export async function setLeadStage(tx: Tx, input: { leadId: string; stageKey: string; lostReason?: string | null }): Promise<void> {
  const [stage] = await tx.select().from(leadStages).where(eq(leadStages.key, input.stageKey));
  if (!stage || !stage.active) throw new MoneyRuleError("Unknown stage.");
  if (stage.kind === "lost" && !input.lostReason?.trim()) throw new MoneyRuleError("Why was this lead lost?");
  const res = await tx
    .update(leads)
    .set({ stageKey: stage.key, lostReason: stage.kind === "lost" ? input.lostReason!.trim().slice(0, 300) : null })
    .where(eq(leads.id, input.leadId))
    .returning({ id: leads.id });
  if (res.length === 0) throw new MoneyRuleError("Lead not found.");
}

export async function assignLead(tx: Tx, input: { leadId: string; userId: string | null; actorId: string }): Promise<void> {
  const res = await tx.update(leads).set({ assignedTo: input.userId }).where(eq(leads.id, input.leadId)).returning({ id: leads.id, name: leads.name });
  if (res.length === 0) throw new MoneyRuleError("Lead not found.");
  if (input.userId && input.userId !== input.actorId) {
    await notifyUsers(tx, [input.userId], { title: `Lead assigned to you: ${res[0].name}`, link: `/app/crm/${input.leadId}` });
  }
}

export async function addFollowup(tx: Tx, input: { leadId: string; dueOn: IsoDate; note: string; assignedTo: string | null }): Promise<string> {
  const [row] = await tx
    .insert(leadFollowups)
    .values({ leadId: input.leadId, dueOn: input.dueOn, note: input.note.trim().slice(0, 300), assignedTo: input.assignedTo })
    .returning({ id: leadFollowups.id });
  return row.id;
}

/** Marks a follow-up done (with what happened) and optionally schedules the next one. */
export async function completeFollowup(
  tx: Tx,
  input: { id: string; outcome: string; actorId: string; next?: { dueOn: IsoDate; note: string } | null },
): Promise<void> {
  const [f] = await tx.select().from(leadFollowups).where(eq(leadFollowups.id, input.id));
  if (!f) throw new MoneyRuleError("Follow-up not found.");
  if (f.doneAt) throw new MoneyRuleError("This follow-up is already done.");
  await tx.update(leadFollowups).set({ doneAt: new Date(), doneBy: input.actorId, outcome: input.outcome.trim().slice(0, 300) || "Done" }).where(eq(leadFollowups.id, f.id));
  await tx.insert(leadActivities).values({
    leadId: f.leadId,
    kind: "follow_up_done",
    body: [f.note, input.outcome.trim()].filter(Boolean).join(" → ").slice(0, 2000) || "Follow-up done",
  });
  if (input.next) await addFollowup(tx, { leadId: f.leadId, dueOn: input.next.dueOn, note: input.next.note, assignedTo: f.assignedTo ?? input.actorId });
}

export type LeadImportResult = { rows: (LeadImportRow & { duplicateOf?: string })[]; created: number; merged: number; committed: boolean };

/**
 * CSV import (preview first). Rows whose mobile matches an open lead are added
 * to that lead's timeline instead of creating a duplicate. Any invalid row blocks the import.
 */
export async function importLeadsCsv(tx: Tx, input: { csvText: string; commit: boolean; assignTo: string | null }): Promise<LeadImportResult> {
  let parsed: { rows: Record<string, string>[] };
  try {
    parsed = parseCsvObjects(input.csvText);
  } catch (e) {
    throw new MoneyRuleError(e instanceof Error ? e.message : "Could not read the CSV file.");
  }
  return importLeadRows(tx, { rows: parsed.rows, commit: input.commit, assignTo: input.assignTo });
}

/**
 * The lead import on already-parsed rows (objects keyed by normalised header), shared by
 * the CSV import above and the spreadsheet import (CSV or Excel) under /app/import.
 */
export async function importLeadRows(
  tx: Tx,
  input: { rows: Record<string, string>[]; commit: boolean; assignTo: string | null; sourceLabel?: string },
): Promise<LeadImportResult> {
  if (input.rows.length === 0) throw new MoneyRuleError("The file has no rows.");
  if (input.rows.length > 2000) throw new MoneyRuleError("Import at most 2,000 leads at a time.");
  const rows: LeadImportResult["rows"] = validateLeadRows(input.rows);
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.error || !r.e164) continue;
    if (seen.has(r.e164)) r.error = `Same mobile as line ${seen.get(r.e164)}.`;
    else seen.set(r.e164, r.line);
    const dup = await findOpenLeadByMobile(tx, r.e164);
    if (dup) r.duplicateOf = dup.name;
  }
  const ok = rows.every((r) => !r.error);
  if (!input.commit || !ok) return { rows, created: 0, merged: 0, committed: false };
  let created = 0;
  let merged = 0;
  for (const r of rows) {
    const lead: NewLead = {
      name: r.name,
      mobile: r.mobile,
      email: r.email,
      fbName: r.fbName,
      source: r.source,
      interest: r.interest,
      location: r.location,
      message: r.notes,
      assignedTo: input.assignTo,
    };
    const res = await recordInquiry(tx, lead);
    if (res.duplicate) merged++;
    else {
      created++;
      await tx.insert(leadActivities).values({ leadId: res.leadId, kind: "import", body: `Imported from ${input.sourceLabel ?? "CSV"} (line ${r.line})` });
    }
  }
  return { rows, created, merged, committed: true };
}

/** Everything held about a lead, for a data-subject access request (RA 10173). */
export async function exportLead(tx: Tx, leadId: string, handledBy: string): Promise<Record<string, unknown> | null> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return null;
  const activities = await tx.select().from(leadActivities).where(eq(leadActivities.leadId, leadId));
  const followups = await tx.select().from(leadFollowups).where(eq(leadFollowups.leadId, leadId));
  await tx.insert(privacyRequests).values({ subjectType: "lead", subjectId: leadId, kind: "export", handledBy });
  return { exportedAt: new Date().toISOString(), lead, activities, followups };
}

/** Deletes a lead and its timeline on request (RA 10173). Only the fact of the erasure is kept. */
export async function eraseLead(tx: Tx, input: { leadId: string; handledBy: string; notes: string }): Promise<void> {
  const res = await tx.delete(leads).where(eq(leads.id, input.leadId)).returning({ id: leads.id });
  if (res.length === 0) throw new MoneyRuleError("Lead not found (or you are not allowed to erase it).");
  await tx.insert(privacyRequests).values({ subjectType: "lead", subjectId: input.leadId, kind: "erase", notes: input.notes.trim().slice(0, 300), handledBy: input.handledBy });
}

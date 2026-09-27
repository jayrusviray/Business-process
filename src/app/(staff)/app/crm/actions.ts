"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { leads, leadStages } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { CONTACT_METHODS, LEAD_SOURCES, normalizeMobile, SERVICE_LINES } from "@/lib/crm";
import { zIsoDate } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import {
  addFollowup,
  addLeadNote,
  assignLead,
  completeFollowup,
  createLead,
  eraseLead,
  findLeadsByMobile,
  importLeadsCsv,
  setLeadStage,
} from "@/server/crm/leads";
import { friendlyError, MoneyRuleError } from "@/server/money/errors";

const CRM = ["owner_admin", "operations", "sales"] as const;

const optionalGuid = z.union([z.literal(""), z.guid()]).transform((v) => v || null);

const LeadForm = z.object({
  name: z.string().trim().min(2, "Enter the lead's name.").max(120),
  mobile: z.string().trim().max(40).default(""),
  email: z.union([z.literal(""), z.email("Enter a valid email or leave it blank.")]).transform((s) => s || null),
  fbName: z.string().trim().max(120).default(""),
  source: z.enum(LEAD_SOURCES),
  interest: z.enum(SERVICE_LINES),
  location: z.string().trim().max(120).default(""),
  preferredContact: z.union([z.literal(""), z.enum(CONTACT_METHODS)]).transform((v) => v || null),
  message: z.string().trim().max(2000).default(""),
  referrerName: z.string().trim().max(120).default(""),
  referrerPhone: z.string().trim().max(40).default(""),
  notes: z.string().trim().max(2000).default(""),
});

/** Manual lead entry (Messenger, walk-ins, referrals…). Warns on duplicate mobile numbers. */
export async function createLeadAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(CRM);
  const obj = formObject(formData);
  const parsed = LeadForm.safeParse(obj);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const assign = optionalGuid.safeParse(obj.assignedTo ?? "");
  const auto = obj.assignedTo === "auto";
  let id: string;
  try {
    id = await withUserTx(session.claims, async (tx) => {
      const phone = normalizeMobile(parsed.data.mobile);
      if (parsed.data.mobile && !phone.e164) throw new MoneyRuleError("Use a PH mobile number like 0917 123 4567, or leave it blank.");
      if (obj.force !== "on") {
        const dups = await findLeadsByMobile(tx, phone.e164);
        if (dups.length) {
          throw new MoneyRuleError(
            `Already in the CRM: ${dups.map((d) => `${d.name} (${d.stage})`).join(", ")}. Open that lead instead, or tick "Create anyway".`,
          );
        }
      }
      const res = await createLead(tx, { ...parsed.data, assignedTo: auto ? undefined : assign.success ? assign.data : session.userId });
      return res.id;
    });
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/crm/${id}`);
}

export async function updateLeadAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(CRM, async (s) => {
    const id = z.guid().parse(obj.leadId);
    const parsed = LeadForm.safeParse(obj);
    if (!parsed.success) throw new MoneyRuleError(parsed.error.issues[0]?.message ?? "Check the form.");
    const phone = normalizeMobile(parsed.data.mobile);
    if (parsed.data.mobile && !phone.e164) throw new MoneyRuleError("Use a PH mobile number like 0917 123 4567, or leave it blank.");
    const d = parsed.data;
    await withUserTx(s.claims, (tx) =>
      tx
        .update(leads)
        .set({
          name: d.name,
          mobile: phone.mobile,
          mobileE164: phone.e164,
          email: d.email,
          fbName: d.fbName,
          source: d.source,
          interest: d.interest,
          location: d.location,
          preferredContact: d.preferredContact,
          referrerName: d.referrerName,
          referrerPhone: d.referrerPhone,
          notes: d.notes,
        })
        .where(eq(leads.id, id)),
    );
    revalidatePath(`/app/crm/${id}`);
    return "Saved.";
  });
}

export async function moveLeadAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(CRM, async (s) => {
    const input = z.object({ leadId: z.guid(), stageKey: z.string().min(1).max(40), lostReason: z.string().trim().max(300).default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => setLeadStage(tx, input));
    revalidatePath("/app/crm");
    revalidatePath(`/app/crm/${input.leadId}`);
    return "Moved.";
  });
}

export async function assignLeadAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(CRM, async (s) => {
    const input = z.object({ leadId: z.guid(), userId: optionalGuid }).parse(obj);
    await withUserTx(s.claims, (tx) => assignLead(tx, { ...input, actorId: s.userId }));
    revalidatePath(`/app/crm/${input.leadId}`);
    return input.userId ? "Assigned." : "Unassigned.";
  });
}

export async function addNoteAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(CRM, async (s) => {
    const input = z.object({ leadId: z.guid(), kind: z.enum(["note", "call", "message"]), body: z.string().max(2000) }).parse(obj);
    await withUserTx(s.claims, (tx) => addLeadNote(tx, input));
    revalidatePath(`/app/crm/${input.leadId}`);
    return "Added to the timeline.";
  });
}

export async function addFollowupAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(CRM, async (s) => {
    const input = z
      .object({ leadId: z.guid(), dueOn: zIsoDate, note: z.string().trim().max(300).default(""), assignedTo: optionalGuid })
      .safeParse(obj);
    if (!input.success) throw new MoneyRuleError(input.error.issues[0]?.message ?? "Check the form.");
    await withUserTx(s.claims, (tx) => addFollowup(tx, { ...input.data, assignedTo: input.data.assignedTo ?? s.userId }));
    revalidatePath(`/app/crm/${input.data.leadId}`);
    revalidatePath("/app/crm/followups");
    return "Follow-up scheduled.";
  });
}

export async function completeFollowupAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(CRM, async (s) => {
    const input = z
      .object({
        id: z.guid(),
        outcome: z.string().trim().max(300).default(""),
        nextDueOn: z.union([z.literal(""), zIsoDate]).default(""),
        nextNote: z.string().trim().max(300).default(""),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) =>
      completeFollowup(tx, {
        id: input.id,
        outcome: input.outcome,
        actorId: s.userId,
        next: input.nextDueOn ? { dueOn: input.nextDueOn, note: input.nextNote } : null,
      }),
    );
    revalidatePath("/app/crm/followups");
    revalidatePath("/app/crm");
    return input.nextDueOn ? "Done. Next follow-up scheduled." : "Done.";
  });
}

export type LeadImportState = {
  ok?: string;
  error?: string;
  preview?: { line: number; name: string; mobile: string; source: string; interest: string; duplicateOf?: string; error?: string }[];
};

export async function importLeadsAction(_: LeadImportState, formData: FormData): Promise<LeadImportState> {
  const session = await requireRole(CRM);
  try {
    const obj = formObject(formData);
    const intent = z.enum(["preview", "import"]).parse(obj.intent);
    const assignTo = optionalGuid.parse(obj.assignTo ?? "");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
    if (file.size > 2 * 1024 * 1024) return { error: "CSV is too large (max 2 MB)." };
    const res = await withUserTx(session.claims, async (tx) => importLeadsCsv(tx, { csvText: await file.text(), commit: intent === "import", assignTo }));
    const preview = res.rows.map((r) => ({ line: r.line, name: r.name, mobile: r.mobile, source: r.source, interest: r.interest, duplicateOf: r.duplicateOf, error: r.error }));
    const bad = preview.filter((r) => r.error).length;
    if (res.committed) {
      revalidatePath("/app/crm");
      return { ok: `Imported: ${res.created} new lead(s), ${res.merged} added to existing leads.`, preview };
    }
    if (bad) return { ok: `${bad} row(s) need fixing. Nothing was imported.`, preview };
    return { ok: `All ${preview.length} row(s) look good${preview.some((r) => r.duplicateOf) ? " (rows matching an open lead are added to that lead)" : ""}. Click Import to save.`, preview };
  } catch (e) {
    return { error: friendlyError(e) };
  }
}

export async function eraseLeadAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin"]);
  const obj = formObject(formData);
  const input = z.object({ leadId: z.guid(), confirm: z.string(), notes: z.string().trim().max(300).default("") }).safeParse(obj);
  if (!input.success) return { error: "Invalid request." };
  if (input.data.confirm.trim().toUpperCase() !== "ERASE") return { error: 'Type ERASE to confirm.' };
  try {
    await withUserTx(session.claims, (tx) => eraseLead(tx, { leadId: input.data.leadId, handledBy: session.userId, notes: input.data.notes }));
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect("/app/crm?erased=1");
}

const StageForm = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Key: lowercase letters, digits and _"),
  label: z.string().trim().min(2).max(60),
  kind: z.enum(["open", "won", "lost"]),
  sort: z.coerce.number().int().min(0).max(1000),
  active: z.string().optional().transform((v) => v === "on"),
});

export async function saveStageAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const input = StageForm.safeParse(obj);
    if (!input.success) throw new MoneyRuleError(input.error.issues[0]?.message ?? "Check the form.");
    const { key, ...rest } = input.data;
    await withUserTx(s.claims, (tx) =>
      obj.mode === "new"
        ? tx.insert(leadStages).values(input.data)
        : tx.update(leadStages).set(rest).where(eq(leadStages.key, key)),
    );
    revalidatePath("/app/crm/stages");
    return "Saved.";
  });
}

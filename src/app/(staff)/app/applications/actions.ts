"use server";

import { eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import {
  applicationCommissionRules,
  applications,
  applicationStatuses,
  applicationTypes,
  checklistTemplates,
  clients,
} from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { normalizeMobile, SERVICE_LINES } from "@/lib/crm";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zPeso, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import {
  addApplicationFee,
  addChecklistItem,
  attachChecklistDocument,
  convertLeadToApplication,
  createApplication,
  createDriverFromApplication,
  findOrCreateClient,
  recordApplicationPayment,
  setApplicationStatus,
  verifyChecklistItem,
  voidApplicationFee,
  voidApplicationPayment,
} from "@/server/applications/service";
import { uploadDocument } from "@/server/documents";
import { friendlyError, MoneyRuleError } from "@/server/money/errors";

const WORKERS = ["owner_admin", "operations", "sales", "documentation"] as const;
const DOCS = ["owner_admin", "operations", "documentation"] as const;
const optionalGuid = z.union([z.literal(""), z.guid()]).optional().transform((v) => v || null);

function first<T>(r: { success: true; data: T } | { success: false; error: z.ZodError }): T {
  if (!r.success) throw new MoneyRuleError(r.error.issues[0]?.message ?? "Check the form.");
  return r.data;
}

const NewApp = z.object({
  typeKey: z.string().min(1, "Choose an application type."),
  clientMode: z.enum(["existing", "new"]),
  clientId: optionalGuid,
  clientKind: z.enum(["person", "company"]).default("person"),
  clientName: z.string().trim().max(160).default(""),
  contactPerson: z.string().trim().max(120).default(""),
  mobile: z.string().trim().max(40).default(""),
  email: z.union([z.literal(""), z.email("Enter a valid email or leave it blank.")]).default("").transform((s) => s || null),
  address: z.string().trim().max(300).default(""),
  assignedTo: optionalGuid,
  vehicleId: optionalGuid,
  quotedFee: z.string().trim().default(""),
  referrerName: z.string().trim().max(120).default(""),
  referrerPhone: z.string().trim().max(40).default(""),
  notes: z.string().trim().max(2000).default(""),
});

export async function createApplicationAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(WORKERS);
  let id: string;
  try {
    const d = first(NewApp.safeParse(formObject(formData)));
    const quotedFee = d.quotedFee === "" ? undefined : first(zPesoOrZero.safeParse(d.quotedFee));
    id = await withUserTx(session.claims, async (tx) => {
      let clientId = d.clientId;
      if (d.clientMode === "new") {
        if (d.mobile && !normalizeMobile(d.mobile).e164) throw new MoneyRuleError("Use a PH mobile number like 0917 123 4567, or leave it blank.");
        clientId = (await findOrCreateClient(tx, { kind: d.clientKind, name: d.clientName, contactPerson: d.contactPerson, mobile: d.mobile, email: d.email, address: d.address })).id;
      }
      if (!clientId) throw new MoneyRuleError("Choose the client.");
      const app = await createApplication(tx, {
        typeKey: d.typeKey,
        clientId,
        assignedTo: d.assignedTo ?? session.userId,
        vehicleId: d.vehicleId,
        source: "staff",
        referrerName: d.referrerName,
        referrerPhone: d.referrerPhone,
        notes: d.notes,
        quotedFee,
      });
      return app.id;
    });
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/applications/${id}`);
}

/** CRM: open an application from a lead (marks the lead converted). */
export async function convertLeadAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(WORKERS);
  let id: string;
  try {
    const obj = formObject(formData);
    const d = first(z.object({ leadId: z.guid(), typeKey: z.string().min(1, "Choose an application type."), assignedTo: optionalGuid }).safeParse(obj));
    id = (await withUserTx(session.claims, (tx) => convertLeadToApplication(tx, { ...d, assignedTo: d.assignedTo ?? session.userId }))).id;
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/applications/${id}`);
}

export async function updateApplicationAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(WORKERS, async (s) => {
    const d = first(
      z
        .object({
          applicationId: z.guid(),
          referenceNo: z.string().trim().max(80).default(""),
          filedOn: z.union([z.literal(""), zIsoDate]).default("").transform((v) => v || null),
          assignedTo: optionalGuid,
          vehicleId: optionalGuid,
          referrerName: z.string().trim().max(120).default(""),
          referrerPhone: z.string().trim().max(40).default(""),
          notes: z.string().trim().max(2000).default(""),
        })
        .safeParse(obj),
    );
    const { applicationId, ...rest } = d;
    await withUserTx(s.claims, (tx) => tx.update(applications).set(rest).where(eq(applications.id, applicationId)));
    revalidatePath(`/app/applications/${applicationId}`);
    return "Saved.";
  });
}

export async function setStatusAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(WORKERS, async (s) => {
    const d = first(
      z
        .object({ applicationId: z.guid(), statusKey: z.string().min(1), note: z.string().trim().max(300).default(""), cancelReason: z.string().trim().max(300).default("") })
        .safeParse(obj),
    );
    const res = await withUserTx(s.claims, (tx) => setApplicationStatus(tx, d));
    revalidatePath(`/app/applications/${d.applicationId}`);
    revalidatePath("/app/applications");
    return res.commissionId ? "Status updated. A referral commission was created for finance to approve." : "Status updated.";
  });
}

export async function uploadChecklistAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(DOCS, async (s) => {
    const d = first(z.object({ itemId: z.guid(), applicationId: z.guid() }).safeParse(obj));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new MoneyRuleError("Choose a file.");
    await withUserTx(s.claims, async (tx) => {
      const documentId = await uploadDocument(tx, { file, ownerType: "application", ownerId: d.applicationId, docType: "checklist", uploadedBy: s.userId });
      await attachChecklistDocument(tx, { itemId: d.itemId, documentId });
    });
    revalidatePath(`/app/applications/${d.applicationId}`);
    return "Uploaded.";
  });
}

export async function verifyChecklistAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(DOCS, async (s) => {
    const d = first(z.object({ itemId: z.guid(), applicationId: z.guid(), verified: z.enum(["1", "0"]), note: z.string().trim().max(300).optional() }).safeParse(obj));
    await withUserTx(s.claims, (tx) => verifyChecklistItem(tx, { itemId: d.itemId, actorId: s.userId, verified: d.verified === "1", note: d.note }));
    revalidatePath(`/app/applications/${d.applicationId}`);
    return d.verified === "1" ? "Verified." : "Verification cleared.";
  });
}

export async function addChecklistItemAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(DOCS, async (s) => {
    const d = first(
      z.object({ applicationId: z.guid(), label: z.string().trim().min(2, "Name the document.").max(200), required: z.string().optional().transform((v) => v === "on") }).safeParse(obj),
    );
    await withUserTx(s.claims, (tx) => addChecklistItem(tx, d));
    revalidatePath(`/app/applications/${d.applicationId}`);
    return "Added.";
  });
}

export async function addFeeAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "operations", "documentation", "finance", "sales"], async (s) => {
    const d = first(z.object({ applicationId: z.guid(), description: z.string().trim().min(2, "Describe the fee.").max(200), amount: zPeso }).safeParse(obj));
    await withUserTx(s.claims, (tx) => addApplicationFee(tx, d));
    revalidatePath(`/app/applications/${d.applicationId}`);
    return "Fee added.";
  });
}

export async function voidFeeAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const d = first(z.object({ id: z.guid(), applicationId: z.guid(), reason: z.string().trim().min(3, "Give a reason.") }).safeParse(obj));
    await withUserTx(s.claims, (tx) => voidApplicationFee(tx, { id: d.id, reason: d.reason, userId: s.userId }));
    revalidatePath(`/app/applications/${d.applicationId}`);
    return "Fee voided.";
  });
}

export async function recordFeePaymentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "operations", "documentation", "finance"], async (s) => {
    const d = first(
      z
        .object({
          applicationId: z.guid(),
          clientRequestId: z.guid(),
          amount: zPeso,
          method: z.enum(["cash", "gcash", "maya", "bank_transfer", "other"]),
          referenceNo: z.string().trim().max(80).default(""),
          bankName: z.string().trim().max(80).default(""),
          receivedOn: zIsoDate,
          notes: z.string().trim().max(300).default(""),
        })
        .safeParse(obj),
    );
    if (d.receivedOn > businessToday()) throw new MoneyRuleError("The payment date can't be in the future.");
    const r = await withUserTx(s.claims, (tx) => recordApplicationPayment(tx, { ...d, receivedBy: s.userId }));
    revalidatePath(`/app/applications/${d.applicationId}`);
    return r.duplicate ? `Already recorded as ${r.receiptNo}.` : `Payment recorded: ${r.receiptNo}.`;
  });
}

export async function voidFeePaymentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const d = first(z.object({ id: z.guid(), applicationId: z.guid(), reason: z.string().trim().min(3, "Give a reason.") }).safeParse(obj));
    await withUserTx(s.claims, (tx) => voidApplicationPayment(tx, { id: d.id, reason: d.reason, userId: s.userId }));
    revalidatePath(`/app/applications/${d.applicationId}`);
    return "Payment voided.";
  });
}

export async function createDriverAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin", "operations"]);
  let driverId: string;
  try {
    const d = first(z.object({ applicationId: z.guid() }).safeParse(formObject(formData)));
    driverId = (await withUserTx(session.claims, (tx) => createDriverFromApplication(tx, d.applicationId))).driverId;
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/drivers/${driverId}`);
}

export async function updateClientAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(WORKERS, async (s) => {
    const d = first(
      z
        .object({
          clientId: z.guid(),
          kind: z.enum(["person", "company"]),
          name: z.string().trim().min(2, "Enter the client's name.").max(160),
          contactPerson: z.string().trim().max(120).default(""),
          mobile: z.string().trim().max(40).default(""),
          email: z.union([z.literal(""), z.email("Enter a valid email or leave it blank.")]).default("").transform((v) => v || null),
          address: z.string().trim().max(300).default(""),
          tin: z.string().trim().max(40).default(""),
          notes: z.string().trim().max(2000).default(""),
        })
        .safeParse(obj),
    );
    const phone = normalizeMobile(d.mobile);
    if (d.mobile && !phone.e164) throw new MoneyRuleError("Use a PH mobile number like 0917 123 4567, or leave it blank.");
    const { clientId, ...rest } = d;
    await withUserTx(s.claims, (tx) => tx.update(clients).set({ ...rest, mobile: phone.mobile, mobileE164: phone.e164 }).where(eq(clients.id, clientId)));
    revalidatePath(`/app/clients/${clientId}`);
    return "Saved.";
  });
}

// ---------------------------------------------------------------------------
// Settings (owner/admin): types, pipeline, checklists, commission rules
// ---------------------------------------------------------------------------
export async function saveTypeAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const d = first(
      z
        .object({
          mode: z.enum(["new", "edit"]),
          key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Key: lowercase letters, digits and _"),
          label: z.string().trim().min(2).max(120),
          serviceLine: z.enum(SERVICE_LINES),
          description: z.string().trim().max(500).default(""),
          defaultFee: zPesoOrZero,
          sort: z.coerce.number().int().min(0).max(1000),
          publicForm: z.string().optional().transform((v) => v === "on"),
          active: z.string().optional().transform((v) => v === "on"),
        })
        .safeParse(obj),
    );
    const row = { label: d.label, serviceLine: d.serviceLine, description: d.description, defaultFeeCentavos: d.defaultFee, sort: d.sort, publicForm: d.publicForm, active: d.active };
    await withUserTx(s.claims, (tx) =>
      d.mode === "new" ? tx.insert(applicationTypes).values({ key: d.key, ...row }) : tx.update(applicationTypes).set(row).where(eq(applicationTypes.key, d.key)),
    );
    revalidatePath("/app/applications/settings");
    revalidateTag("site", { expire: 0 }); // the public /apply form lists the types
    return "Saved.";
  });
}

export async function saveStatusAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const d = first(
      z
        .object({
          mode: z.enum(["new", "edit"]),
          key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Key: lowercase letters, digits and _"),
          label: z.string().trim().min(2).max(60),
          kind: z.enum(["open", "approved", "completed", "on_hold", "cancelled"]),
          sort: z.coerce.number().int().min(0).max(1000),
          active: z.string().optional().transform((v) => v === "on"),
        })
        .safeParse(obj),
    );
    const { mode, key, ...rest } = d;
    await withUserTx(s.claims, (tx) =>
      mode === "new" ? tx.insert(applicationStatuses).values({ key, ...rest }) : tx.update(applicationStatuses).set(rest).where(eq(applicationStatuses.key, key)),
    );
    revalidatePath("/app/applications/settings");
    return "Saved.";
  });
}

export async function saveTemplateAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const d = first(
      z
        .object({
          id: optionalGuid,
          typeKey: z.string().min(1),
          label: z.string().trim().min(2).max(200),
          required: z.string().optional().transform((v) => v === "on"),
          sort: z.coerce.number().int().min(0).max(1000),
          active: z.string().optional().transform((v) => v === "on"),
        })
        .safeParse(obj),
    );
    const { id, ...rest } = d;
    await withUserTx(s.claims, (tx) => (id ? tx.update(checklistTemplates).set(rest).where(eq(checklistTemplates.id, id)) : tx.insert(checklistTemplates).values(rest)));
    revalidatePath("/app/applications/settings");
    return "Saved. New applications use the updated checklist.";
  });
}

export async function saveCommissionRuleAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const d = first(
      z
        .object({
          typeKey: z.string().min(1),
          mode: z.enum(["fixed", "percent"]),
          amount: zPesoOrZero,
          ratePct: z.string().trim().default("0"),
          active: z.string().optional().transform((v) => v === "on"),
        })
        .safeParse(obj),
    );
    // Percent entered with up to two decimals → basis points, exactly (no floats).
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(d.ratePct || "0");
    if (!m) throw new MoneyRuleError("Enter the percentage like 10 or 12.5.");
    const rateBps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
    if (rateBps > 10000) throw new MoneyRuleError("The percentage can't be more than 100.");
    const row = { mode: d.mode, amountCentavos: d.mode === "fixed" ? d.amount : BigInt(0), rateBps: d.mode === "percent" ? rateBps : 0, active: d.active };
    await withUserTx(s.claims, (tx) =>
      tx.insert(applicationCommissionRules).values({ typeKey: d.typeKey, ...row }).onConflictDoUpdate({ target: applicationCommissionRules.typeKey, set: row }),
    );
    revalidatePath("/app/applications/settings");
    return "Commission rule saved.";
  });
}

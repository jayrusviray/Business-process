import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  applicationChecklistItems,
  applicationCommissionRules,
  applicationCommissions,
  applicationFees,
  applicationPayments,
  applications,
  applicationStatuses,
  applicationTypes,
  checklistTemplates,
  clients,
  drivers,
  leadActivities,
  leads,
  leadStages,
} from "@/db/schema";
import { applicationCommission, feeBalance, splitName } from "@/lib/applications";
import { normalizeMobile } from "@/lib/crm";
import type { IsoDate } from "@/lib/dates";
import { ZERO, type Centavos } from "@/lib/money";
import { MoneyRuleError } from "../money/errors";

export type ClientInput = {
  kind?: "person" | "company";
  name: string;
  contactPerson?: string;
  mobile?: string;
  email?: string | null;
  address?: string;
  tin?: string;
  notes?: string;
  leadId?: string | null;
  driverId?: string | null;
};

/** Reuses the client with the same PH mobile number, or creates one. */
export async function findOrCreateClient(tx: Tx, input: ClientInput): Promise<{ id: string; created: boolean }> {
  const name = input.name.trim();
  if (!name) throw new MoneyRuleError("Enter the client's name.");
  const phone = normalizeMobile(input.mobile ?? "");
  if (phone.e164) {
    const [existing] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.mobileE164, phone.e164)).limit(1);
    if (existing) return { id: existing.id, created: false };
  }
  const [row] = await tx
    .insert(clients)
    .values({
      kind: input.kind ?? "person",
      name: name.slice(0, 160),
      contactPerson: input.contactPerson?.trim() ?? "",
      mobile: phone.mobile,
      mobileE164: phone.e164,
      email: input.email?.trim() || null,
      address: input.address?.trim() ?? "",
      tin: input.tin?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
      leadId: input.leadId ?? null,
      driverId: input.driverId ?? null,
    })
    .returning({ id: clients.id });
  return { id: row.id, created: true };
}

export type NewApplication = {
  typeKey: string;
  clientId: string;
  leadId?: string | null;
  vehicleId?: string | null;
  assignedTo?: string | null;
  source: "staff" | "public";
  referrerName?: string;
  referrerPhone?: string;
  notes?: string;
  /** Service fee to quote. undefined = the type's default fee (staff only); 0 = none. */
  quotedFee?: Centavos;
};

/** Opens an application: copies the type's checklist and quotes the service fee. */
export async function createApplication(tx: Tx, input: NewApplication): Promise<{ id: string; appNo: string }> {
  const [type] = await tx.select().from(applicationTypes).where(eq(applicationTypes.key, input.typeKey));
  if (!type || !type.active) throw new MoneyRuleError("Choose an application type.");
  const [app] = await tx
    .insert(applications)
    .values({
      typeKey: type.key,
      clientId: input.clientId,
      leadId: input.leadId ?? null,
      vehicleId: input.vehicleId ?? null,
      assignedTo: input.assignedTo ?? null,
      source: input.source,
      referrerName: input.referrerName?.trim() ?? "",
      referrerPhone: input.referrerPhone?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
    })
    .returning({ id: applications.id, appNo: applications.appNo });
  const templates = await tx
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.typeKey, type.key), eq(checklistTemplates.active, true)))
    .orderBy(asc(checklistTemplates.sort));
  if (templates.length) {
    await tx.insert(applicationChecklistItems).values(
      templates.map((t) => ({ applicationId: app.id, label: t.label, required: t.required, sort: t.sort, templateId: t.id })),
    );
  }
  const fee = input.quotedFee ?? (input.source === "staff" ? type.defaultFeeCentavos : ZERO);
  if (fee < ZERO) throw new MoneyRuleError("The fee can't be negative.");
  if (fee > ZERO) await tx.insert(applicationFees).values({ applicationId: app.id, description: "Service fee", amountCentavos: fee });
  return app;
}

/** Opens an application from a CRM lead and marks the lead converted. */
export async function convertLeadToApplication(
  tx: Tx,
  input: { leadId: string; typeKey: string; assignedTo: string | null; quotedFee?: Centavos },
): Promise<{ id: string; appNo: string }> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, input.leadId));
  if (!lead) throw new MoneyRuleError("Lead not found.");
  const client = await findOrCreateClient(tx, { name: lead.name, mobile: lead.mobile, email: lead.email, address: lead.location, leadId: lead.id });
  const app = await createApplication(tx, {
    typeKey: input.typeKey,
    clientId: client.id,
    leadId: lead.id,
    assignedTo: input.assignedTo,
    source: "staff",
    referrerName: lead.referrerName,
    referrerPhone: lead.referrerPhone,
    notes: lead.message,
    quotedFee: input.quotedFee,
  });
  const [won] = await tx
    .select({ key: leadStages.key })
    .from(leadStages)
    .where(and(eq(leadStages.kind, "won"), eq(leadStages.active, true)))
    .orderBy(asc(leadStages.sort))
    .limit(1);
  if (won && lead.stageKey !== won.key) await tx.update(leads).set({ stageKey: won.key, lostReason: null }).where(eq(leads.id, lead.id));
  const [type] = await tx.select({ label: applicationTypes.label }).from(applicationTypes).where(eq(applicationTypes.key, input.typeKey));
  await tx.insert(leadActivities).values({
    leadId: lead.id,
    kind: "converted",
    body: `Application ${app.appNo} opened: ${type?.label ?? input.typeKey}`,
    meta: { applicationId: app.id, appNo: app.appNo },
  });
  return app;
}

/**
 * Moves an application along the pipeline. The history row is written by a
 * trigger (with the note). Approval creates the referral commission, if a rule applies.
 */
export async function setApplicationStatus(
  tx: Tx,
  input: { applicationId: string; statusKey: string; note?: string; cancelReason?: string | null },
): Promise<{ commissionId: string | null }> {
  const [status] = await tx.select().from(applicationStatuses).where(eq(applicationStatuses.key, input.statusKey));
  if (!status || !status.active) throw new MoneyRuleError("Unknown status.");
  if (status.kind === "cancelled" && !input.cancelReason?.trim()) throw new MoneyRuleError("Why is this application cancelled?");
  await tx.execute(sql`SELECT set_config('app.status_note', ${(input.note ?? "").trim().slice(0, 300)}, true)`);
  const res = await tx
    .update(applications)
    .set({ statusKey: status.key, cancelReason: status.kind === "cancelled" ? input.cancelReason!.trim().slice(0, 300) : null })
    .where(eq(applications.id, input.applicationId))
    .returning({ id: applications.id });
  await tx.execute(sql`SELECT set_config('app.status_note', '', true)`);
  if (res.length === 0) throw new MoneyRuleError("Application not found.");
  const commissionId = status.kind === "approved" || status.kind === "completed" ? await maybeCreateCommission(tx, input.applicationId) : null;
  return { commissionId };
}

/** Referral commission for an approved application: once, and only if it has a referrer and an active rule. */
export async function maybeCreateCommission(tx: Tx, applicationId: string): Promise<string | null> {
  const [app] = await tx.select().from(applications).where(eq(applications.id, applicationId));
  if (!app || !app.referrerName.trim()) return null;
  const [existing] = await tx
    .select({ id: applicationCommissions.id })
    .from(applicationCommissions)
    .where(and(eq(applicationCommissions.applicationId, applicationId), ne(applicationCommissions.status, "void")));
  if (existing) return null;
  const [rule] = await tx.select().from(applicationCommissionRules).where(eq(applicationCommissionRules.typeKey, app.typeKey));
  const money = await applicationMoney(tx, applicationId);
  const c = applicationCommission(rule ? { ...rule, amountCentavos: rule.amountCentavos } : null, money.charged);
  if (!c || !rule) return null;
  const [row] = await tx
    .insert(applicationCommissions)
    .values({
      applicationId,
      referrerName: app.referrerName.trim(),
      referrerPhone: app.referrerPhone.trim(),
      mode: rule.mode,
      baseCentavos: c.base,
      rateBps: rule.mode === "percent" ? rule.rateBps : 0,
      amountCentavos: c.amount,
    })
    .returning({ id: applicationCommissions.id });
  return row.id;
}

/** Fees charged, paid and the balance of an application (void rows excluded). */
export async function applicationMoney(tx: Tx, applicationId: string) {
  const fees = await tx.select().from(applicationFees).where(eq(applicationFees.applicationId, applicationId)).orderBy(asc(applicationFees.createdAt));
  const payments = await tx
    .select()
    .from(applicationPayments)
    .where(eq(applicationPayments.applicationId, applicationId))
    .orderBy(asc(applicationPayments.receivedOn), asc(applicationPayments.createdAt));
  const totals = feeBalance(
    fees.map((f) => ({ amount: f.amountCentavos, voided: !!f.voidedAt })),
    payments.map((p) => ({ amount: p.amountCentavos, voided: !!p.voidedAt })),
  );
  return { fees, payments, ...totals };
}

export async function addApplicationFee(tx: Tx, input: { applicationId: string; description: string; amount: Centavos }): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (!input.description.trim()) throw new MoneyRuleError("Describe the fee.");
  const [row] = await tx
    .insert(applicationFees)
    .values({ applicationId: input.applicationId, description: input.description.trim().slice(0, 200), amountCentavos: input.amount })
    .returning({ id: applicationFees.id });
  return row.id;
}

export async function voidApplicationFee(tx: Tx, input: { id: string; reason: string; userId: string }): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const res = await tx
    .update(applicationFees)
    .set({ voidedAt: new Date(), voidedBy: input.userId, voidReason: input.reason.trim() })
    .where(and(eq(applicationFees.id, input.id), isNull(applicationFees.voidedAt)))
    .returning({ id: applicationFees.id });
  if (res.length === 0) throw new MoneyRuleError("Fee not found or already void.");
}

export type ApplicationPaymentInput = {
  applicationId: string;
  amount: Centavos;
  method: "cash" | "gcash" | "maya" | "bank_transfer" | "other";
  referenceNo?: string | null;
  bankName?: string | null;
  receivedOn: IsoDate;
  receivedBy: string;
  notes?: string;
  clientRequestId: string;
};

/** Records a fee payment (idempotent on clientRequestId). */
export async function recordApplicationPayment(tx: Tx, input: ApplicationPaymentInput): Promise<{ id: string; receiptNo: string; duplicate: boolean }> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (input.method !== "cash" && !input.referenceNo?.trim()) throw new MoneyRuleError("A reference number is required for non-cash payments.");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('transrev:application:' || ${input.applicationId}))`);
  const [existing] = await tx
    .select({ id: applicationPayments.id, receiptNo: applicationPayments.receiptNo })
    .from(applicationPayments)
    .where(eq(applicationPayments.clientRequestId, input.clientRequestId));
  if (existing) return { ...existing, duplicate: true };
  const [row] = await tx
    .insert(applicationPayments)
    .values({
      applicationId: input.applicationId,
      amountCentavos: input.amount,
      method: input.method,
      referenceNo: input.referenceNo?.trim() || null,
      bankName: input.bankName?.trim() || null,
      receivedOn: input.receivedOn,
      receivedBy: input.receivedBy,
      notes: input.notes?.trim() ?? "",
      clientRequestId: input.clientRequestId,
    })
    .returning({ id: applicationPayments.id, receiptNo: applicationPayments.receiptNo });
  return { ...row, duplicate: false };
}

export async function voidApplicationPayment(tx: Tx, input: { id: string; reason: string; userId: string }): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const res = await tx
    .update(applicationPayments)
    .set({ voidedAt: new Date(), voidedBy: input.userId, voidReason: input.reason.trim() })
    .where(and(eq(applicationPayments.id, input.id), isNull(applicationPayments.voidedAt)))
    .returning({ id: applicationPayments.id });
  if (res.length === 0) throw new MoneyRuleError("Payment not found or already void.");
}

export async function addChecklistItem(tx: Tx, input: { applicationId: string; label: string; required: boolean }): Promise<void> {
  if (!input.label.trim()) throw new MoneyRuleError("Name the document.");
  await tx.insert(applicationChecklistItems).values({ applicationId: input.applicationId, label: input.label.trim().slice(0, 200), required: input.required, sort: 500 });
}

export async function attachChecklistDocument(tx: Tx, input: { itemId: string; documentId: string }): Promise<void> {
  const res = await tx.update(applicationChecklistItems).set({ documentId: input.documentId }).where(eq(applicationChecklistItems.id, input.itemId)).returning({ id: applicationChecklistItems.id });
  if (res.length === 0) throw new MoneyRuleError("You are not allowed to upload documents for this application.");
}

/** Marks a checklist item verified (or clears it). An original seen at the office can be verified without a file. */
export async function verifyChecklistItem(tx: Tx, input: { itemId: string; actorId: string; verified: boolean; note?: string }): Promise<void> {
  const res = await tx
    .update(applicationChecklistItems)
    .set(
      input.verified
        ? { verifiedAt: new Date(), verifiedBy: input.actorId, ...(input.note !== undefined ? { note: input.note.trim().slice(0, 300) } : {}) }
        : { verifiedAt: null, verifiedBy: null },
    )
    .where(eq(applicationChecklistItems.id, input.itemId))
    .returning({ id: applicationChecklistItems.id });
  if (res.length === 0) throw new MoneyRuleError("You are not allowed to verify documents for this application.");
}

/**
 * Approved driver-program application → driver profile (status "applicant"),
 * or links the existing driver with the same mobile number.
 */
export async function createDriverFromApplication(tx: Tx, applicationId: string): Promise<{ driverId: string; created: boolean }> {
  const [row] = await tx
    .select({ app: applications, client: clients, kind: applicationStatuses.kind })
    .from(applications)
    .innerJoin(clients, eq(clients.id, applications.clientId))
    .innerJoin(applicationStatuses, eq(applicationStatuses.key, applications.statusKey))
    .where(eq(applications.id, applicationId));
  if (!row) throw new MoneyRuleError("Application not found.");
  if (row.app.typeKey !== "driver_program") throw new MoneyRuleError("Only driver program applications become drivers.");
  if (row.kind !== "approved" && row.kind !== "completed") throw new MoneyRuleError("Approve the application first.");
  if (row.app.driverId) return { driverId: row.app.driverId, created: false };
  const phone = normalizeMobile(row.client.mobile);
  if (!phone.e164) throw new MoneyRuleError("Add the client's PH mobile number first (it becomes the driver's login).");
  const [existing] = await tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.phone, phone.mobile)).limit(1);
  let driverId = existing?.id;
  if (!driverId) {
    const name = splitName(row.client.name);
    const [d] = await tx
      .insert(drivers)
      .values({
        firstName: name.firstName || name.lastName,
        lastName: name.firstName ? name.lastName : "-",
        phone: phone.mobile,
        email: row.client.email,
        address: row.client.address,
        status: "applicant",
        notes: `From application ${row.app.appNo}`,
      })
      .returning({ id: drivers.id });
    driverId = d.id;
  }
  await tx.update(applications).set({ driverId }).where(eq(applications.id, applicationId));
  await tx.update(clients).set({ driverId }).where(eq(clients.id, row.client.id));
  return { driverId, created: !existing };
}

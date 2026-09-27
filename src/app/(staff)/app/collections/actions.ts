"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withSystemTx, withUserTx } from "@/db/client";
import { holidays } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { formatPeso } from "@/lib/money";
import { zIsoDate, zPeso, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { uploadDocument } from "@/server/documents";
import { runDailyCharges } from "@/server/money/charges";
import { friendlyError, MoneyRuleError } from "@/server/money/errors";
import { closeDay } from "@/server/money/day-close";
import { createRemittance, recordPayment, voidPayment } from "@/server/money/payments";
import { approveProof, rejectProof } from "@/server/money/proofs";

const STAFF_COLLECT = ["owner_admin", "finance", "operations"] as const;

const PaymentHeader = z.object({
  paymentId: z.guid(),
  clientRequestId: z.guid(),
  driverId: z.guid(),
  method: z.enum(["cash", "gcash", "maya", "bank_transfer", "other"]),
  referenceNo: z.string().trim().max(80).default(""),
  bankName: z.string().trim().max(80).default(""),
  businessDate: zIsoDate,
  collectorId: z.guid(),
  notes: z.string().trim().max(500).default(""),
});

/** Record payment form: one amount per account (the collector's split). */
export async function recordPaymentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(STAFF_COLLECT);
  const obj = formObject(formData);
  const header = PaymentHeader.safeParse(obj);
  if (!header.success) return { error: header.error.issues[0]?.message ?? "Invalid input." };
  const lines: { accountId: string; amount: bigint }[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("amount:")) continue;
    const parsed = zPesoOrZero.safeParse(v);
    if (!parsed.success) return { error: parsed.error.issues[0].message };
    if (parsed.data !== BigInt(0)) lines.push({ accountId: z.guid().parse(k.slice(7)), amount: parsed.data });
  }
  const file = formData.get("receipt");
  let receiptNo: string;
  try {
    const h = header.data;
    const res = await withUserTx(session.claims, async (tx) => {
      const receiptDocumentId =
        file instanceof File && file.size > 0
          ? await uploadDocument(tx, { file, ownerType: "payment", ownerId: h.paymentId, docType: "payment_receipt", uploadedBy: session.userId })
          : null;
      return recordPayment(tx, {
        ...h,
        id: h.paymentId,
        referenceNo: h.referenceNo || null,
        bankName: h.bankName || null,
        receivedAt: new Date(),
        receiptDocumentId,
        lines,
      });
    });
    receiptNo = res.id;
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/collections/receipts/${receiptNo}?saved=1`);
}

/** End-of-day bulk posting to boundary accounts. All rows succeed or nothing is saved. */
export async function bulkPaymentsAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(STAFF_COLLECT, async (s) => {
    const common = z.object({ businessDate: zIsoDate, collectorId: z.guid() }).parse(obj);
    const rows = Object.keys(obj)
      .filter((k) => k.startsWith("amount:"))
      .map((k) => {
        const accountId = k.slice(7);
        return {
          accountId,
          driverId: obj[`driver:${accountId}`],
          clientRequestId: obj[`req:${accountId}`],
          amount: obj[k],
          method: obj[`method:${accountId}`] ?? "cash",
          referenceNo: obj[`ref:${accountId}`] ?? "",
        };
      })
      .filter((r) => r.amount.trim() !== "");
    if (rows.length === 0) throw new MoneyRuleError("Enter at least one amount.");
    const parsed = rows.map((r, i) => {
      const p = z
        .object({
          accountId: z.guid(),
          driverId: z.guid(),
          clientRequestId: z.guid(),
          amount: zPeso,
          method: z.enum(["cash", "gcash", "maya", "bank_transfer", "other"]),
          referenceNo: z.string().trim(),
        })
        .safeParse(r);
      if (!p.success) throw new MoneyRuleError(`Row ${i + 1}: ${p.error.issues[0].message}`);
      if (p.data.amount <= BigInt(0)) throw new MoneyRuleError(`Row ${i + 1}: amount must be positive.`);
      return p.data;
    });
    let posted = 0;
    await withUserTx(s.claims, async (tx) => {
      for (const r of parsed) {
        const res = await recordPayment(tx, {
          clientRequestId: r.clientRequestId,
          driverId: r.driverId,
          method: r.method,
          referenceNo: r.referenceNo || null,
          receivedAt: new Date(),
          businessDate: common.businessDate,
          collectorId: common.collectorId,
          notes: "Bulk entry",
          lines: [{ accountId: r.accountId, amount: r.amount }],
        });
        if (!res.duplicate) posted++;
      }
    });
    revalidatePath("/app/collections");
    return `${posted} payment${posted === 1 ? "" : "s"} posted${posted < parsed.length ? ` (${parsed.length - posted} already posted earlier)` : ""}.`;
  });
}

export async function voidPaymentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ paymentId: z.guid(), reason: z.string().trim().min(3, "Give a reason") }).parse(obj);
    await withUserTx(s.claims, (tx) => voidPayment(tx, { ...input, voidedBy: s.userId }));
    revalidatePath(`/app/collections/receipts/${input.paymentId}`);
    return "Payment voided and reversed.";
  });
}

export async function createRemittanceAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  const paymentIds = formData.getAll("paymentId").filter((v): v is string => typeof v === "string");
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ collectorId: z.guid(), remitted: zPeso, notes: z.string().default("") }).parse(obj);
    const r = await withUserTx(s.claims, (tx) =>
      createRemittance(tx, {
        collectorId: input.collectorId,
        paymentIds: z.array(z.guid()).parse(paymentIds),
        remitted: input.remitted,
        businessDate: businessToday(),
        receivedBy: s.userId,
        notes: input.notes,
      }),
    );
    revalidatePath("/app/collections/remittances");
    const v = r.variance;
    return v === BigInt(0)
      ? "Remittance recorded. No variance."
      : `Remittance recorded. Variance: ${v < BigInt(0) ? "short" : "over"} ${formatPeso(v < BigInt(0) ? -v : v)}.`;
  });
}

export async function runChargesNowAction(): Promise<ActionState> {
  return guarded(["owner_admin", "finance"], async (s) => {
    const r = await withSystemTx(`manual:${s.userId}`, (tx) => runDailyCharges(tx, businessToday(), `manual:${s.profile.fullName || s.userId}`));
    revalidatePath("/app/collections/charges");
    return `Posted ${r.chargesPosted} charge(s) for ${r.fromDate} → ${r.toDate}.`;
  });
}

export async function addHolidayAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const input = z.object({ date: zIsoDate, name: z.string().trim().min(2).max(120) }).parse(obj);
    await withUserTx(s.claims, (tx) => tx.insert(holidays).values(input));
    revalidatePath("/app/admin/holidays");
    return input.date < businessToday()
      ? "Holiday added. It is in the past: reverse any boundary charges already posted for that day."
      : "Holiday added.";
  });
}

export async function removeHolidayAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const date = zIsoDate.parse(obj.date);
    if (date <= businessToday()) throw new MoneyRuleError("Past holidays can't be removed (charges were already skipped).");
    await withUserTx(s.claims, (tx) => tx.delete(holidays).where(eq(holidays.date, date)));
    revalidatePath("/app/admin/holidays");
    return "Holiday removed.";
  });
}

/** Finance verifies a driver's payment proof, splitting it across the driver's accounts. */
export async function approveProofAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const proofId = z.guid().parse(obj.proofId);
    const lines: { accountId: string; amount: bigint }[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith("amount:")) continue;
      const parsed = zPesoOrZero.safeParse(v);
      if (!parsed.success) throw new MoneyRuleError(parsed.error.issues[0].message);
      if (parsed.data !== BigInt(0)) lines.push({ accountId: z.guid().parse(k.slice(7)), amount: parsed.data });
    }
    const r = await withUserTx(s.claims, (tx) => approveProof(tx, { proofId, lines, decidedBy: s.userId }));
    revalidatePath("/app/collections/proofs");
    return `Verified. Payment ${r.receiptNo} recorded.`;
  });
}

export async function rejectProofAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ proofId: z.guid(), reason: z.string().trim().min(3, "Give the driver a reason").max(300) }).safeParse(obj);
    if (!input.success) throw new MoneyRuleError(input.error.issues[0].message);
    await withUserTx(s.claims, (tx) => rejectProof(tx, { ...input.data, decidedBy: s.userId }));
    revalidatePath("/app/collections/proofs");
    return "Proof rejected. The driver sees your reason in the portal.";
  });
}

export async function closeDayAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ date: zIsoDate, notes: z.string().trim().max(500).default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => closeDay(tx, { ...input, today: businessToday(), closedBy: s.userId }));
    revalidatePath("/app/collections/close");
    return `${input.date} closed.`;
  });
}

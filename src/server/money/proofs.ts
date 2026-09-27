import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { paymentProofs } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { sum, ZERO, type Centavos } from "@/lib/money";
import { MoneyRuleError } from "./errors";
import { lockDriver } from "./fleet";
import { recordPayment } from "./payments";

export type ProofMethod = "gcash" | "maya" | "bank_transfer" | "other";

/**
 * A driver submits a payment screenshot. The file must already be uploaded as a
 * `payment_proof` document owned by this proof id (see uploadDocument). Nothing
 * reaches the ledger until finance approves.
 */
export async function submitProof(
  tx: Tx,
  input: {
    id: string;
    driverId: string;
    amount: Centavos;
    method: ProofMethod;
    referenceNo: string;
    paidOn: IsoDate;
    documentId: string;
    note?: string;
    submittedBy: string;
    today: IsoDate;
  },
): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Enter the amount you sent.");
  if (!input.referenceNo.trim()) throw new MoneyRuleError("Enter the reference number from your GCash/Maya/bank receipt.");
  if (input.paidOn > input.today) throw new MoneyRuleError("The payment date can't be in the future.");
  const [row] = await tx
    .insert(paymentProofs)
    .values({
      id: input.id,
      driverId: input.driverId,
      amountCentavos: input.amount,
      method: input.method,
      referenceNo: input.referenceNo.trim(),
      paidOn: input.paidOn,
      documentId: input.documentId,
      note: input.note?.trim() ?? "",
      submittedBy: input.submittedBy,
    })
    .returning({ id: paymentProofs.id });
  return row.id;
}

/**
 * Finance verifies a proof: records a normal payment (split across the driver's
 * accounts by finance, like any collector) dated the day the driver paid, and
 * marks the proof approved. The proof id is the payment's idempotency key.
 */
export async function approveProof(
  tx: Tx,
  input: { proofId: string; lines: { accountId: string; amount: Centavos }[]; decidedBy: string; receivedAt?: Date },
): Promise<{ paymentId: string; receiptNo: string }> {
  const [proof] = await tx.select().from(paymentProofs).where(eq(paymentProofs.id, input.proofId));
  if (!proof) throw new MoneyRuleError("Payment proof not found.");
  await lockDriver(tx, proof.driverId);
  if (proof.status !== "pending") throw new MoneyRuleError("This payment proof was already decided.");
  const lines = input.lines.filter((l) => l.amount !== ZERO);
  if (sum(lines.map((l) => l.amount)) !== proof.amountCentavos) {
    throw new MoneyRuleError("The split must add up exactly to the amount on the proof. If the amount is wrong, reject the proof.");
  }
  const payment = await recordPayment(tx, {
    clientRequestId: proof.id,
    driverId: proof.driverId,
    method: proof.method,
    referenceNo: proof.referenceNo,
    receivedAt: input.receivedAt ?? new Date(),
    businessDate: proof.paidOn as IsoDate,
    collectorId: input.decidedBy,
    notes: proof.note ? `Portal proof: ${proof.note}` : "Portal proof",
    receiptDocumentId: proof.documentId,
    lines,
  });
  // RLS lets only owner_admin/finance decide. Zero rows means not allowed: throw so the payment rolls back too.
  const decided = await tx
    .update(paymentProofs)
    .set({ status: "approved", decidedBy: input.decidedBy, decidedAt: new Date(), paymentId: payment.id })
    .where(and(eq(paymentProofs.id, proof.id), eq(paymentProofs.status, "pending")))
    .returning({ id: paymentProofs.id });
  if (decided.length === 0) throw new MoneyRuleError("You are not allowed to verify payment proofs.");
  return { paymentId: payment.id, receiptNo: payment.receiptNo };
}

export async function rejectProof(tx: Tx, input: { proofId: string; reason: string; decidedBy: string }): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("Give the driver a reason.");
  const res = await tx
    .update(paymentProofs)
    .set({ status: "rejected", decidedBy: input.decidedBy, decidedAt: new Date(), rejectReason: input.reason.trim() })
    .where(and(eq(paymentProofs.id, input.proofId), eq(paymentProofs.status, "pending")))
    .returning({ id: paymentProofs.id });
  if (res.length === 0) throw new MoneyRuleError("Payment proof not found or already decided.");
}

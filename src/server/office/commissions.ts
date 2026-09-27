import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { applicationCommissions, commissionsReceived, referralCommissions, rtoContracts } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { ZERO, type Centavos } from "@/lib/money";
import { referralCommission } from "@/lib/office";
import { MoneyRuleError } from "../money/errors";
import { getSetting } from "./settings";

/** Owner: 10% (setting) of the referred driver's down payment, payable one month (setting) after the contract start. */
export async function createReferralCommission(
  tx: Tx,
  input: { rtoContractId: string; referrerType: "driver" | "employee" | "external"; referrerName: string; referrerPhone?: string; referrerDriverId?: string | null },
): Promise<string> {
  const [c] = await tx.select().from(rtoContracts).where(eq(rtoContracts.id, input.rtoContractId));
  if (!c) throw new MoneyRuleError("Contract not found.");
  if (c.downPaymentCentavos <= ZERO) throw new MoneyRuleError("This contract has no down payment, so there is no referral commission.");
  if (!input.referrerName.trim()) throw new MoneyRuleError("Enter who referred the driver.");
  const [rate, wait] = await Promise.all([getSetting(tx, "commissions.referral_rate_bps"), getSetting(tx, "commissions.referral_wait_months")]);
  const { amount, payableOn } = referralCommission(c.downPaymentCentavos, rate, c.startDate as IsoDate, wait);
  const [row] = await tx
    .insert(referralCommissions)
    .values({
      rtoContractId: c.id,
      referrerType: input.referrerType,
      referrerName: input.referrerName.trim(),
      referrerPhone: input.referrerPhone?.trim() ?? "",
      referrerDriverId: input.referrerDriverId ?? null,
      baseCentavos: c.downPaymentCentavos,
      rateBps: rate,
      amountCentavos: amount,
      payableOn,
    })
    .returning({ id: referralCommissions.id });
  return row.id;
}

export async function approveReferral(tx: Tx, id: string, userId: string, today: IsoDate): Promise<void> {
  const [r] = await tx.select().from(referralCommissions).where(eq(referralCommissions.id, id));
  if (!r) throw new MoneyRuleError("Commission not found.");
  if (r.payableOn > today) throw new MoneyRuleError(`Not yet payable: it becomes payable on ${r.payableOn}.`);
  await tx.update(referralCommissions).set({ status: "approved", approvedAt: new Date(), approvedBy: userId }).where(eq(referralCommissions.id, id));
}

export async function payReferral(tx: Tx, id: string, paidOn: IsoDate, reference: string): Promise<void> {
  const res = await tx
    .update(referralCommissions)
    .set({ status: "paid", paidOn, paidReference: reference })
    .where(and(eq(referralCommissions.id, id), eq(referralCommissions.status, "approved")))
    .returning({ id: referralCommissions.id });
  if (res.length === 0) throw new MoneyRuleError("Approve the commission before paying it.");
}

export async function voidReferral(tx: Tx, id: string, reason: string): Promise<void> {
  await tx.update(referralCommissions).set({ status: "void", voidReason: reason.trim() }).where(eq(referralCommissions.id, id));
}

export async function recordCommissionReceived(
  tx: Tx,
  input: { sourceType: "platform" | "dealer" | "other"; counterparty: string; description: string; amount: Centavos; receivedOn: IsoDate; reference?: string; vehicleId?: string | null; driverId?: string | null },
): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  const [row] = await tx
    .insert(commissionsReceived)
    .values({ ...input, amountCentavos: input.amount, reference: input.reference ?? "", counterparty: input.counterparty.trim(), description: input.description.trim() })
    .returning({ id: commissionsReceived.id });
  return row.id;
}

export async function voidCommissionReceived(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
  const res = await tx
    .update(commissionsReceived)
    .set({ voidedAt: new Date(), voidedBy: userId, voidReason: reason.trim() })
    .where(and(eq(commissionsReceived.id, id), isNull(commissionsReceived.voidedAt)))
    .returning({ id: commissionsReceived.id });
  if (res.length === 0) throw new MoneyRuleError("Not found or already void.");
}

// ---------------------------------------------------------------------------
// Application referral commissions (spec 4.11): pending → approved → paid, or void.
// ---------------------------------------------------------------------------
export async function approveApplicationCommission(tx: Tx, id: string, userId: string): Promise<void> {
  const res = await tx
    .update(applicationCommissions)
    .set({ status: "approved", approvedAt: new Date(), approvedBy: userId })
    .where(and(eq(applicationCommissions.id, id), eq(applicationCommissions.status, "pending")))
    .returning({ id: applicationCommissions.id });
  if (res.length === 0) throw new MoneyRuleError("Commission not found or not pending.");
}

export async function payApplicationCommission(tx: Tx, id: string, paidOn: IsoDate, reference: string): Promise<void> {
  const res = await tx
    .update(applicationCommissions)
    .set({ status: "paid", paidOn, paidReference: reference })
    .where(and(eq(applicationCommissions.id, id), eq(applicationCommissions.status, "approved")))
    .returning({ id: applicationCommissions.id });
  if (res.length === 0) throw new MoneyRuleError("Approve the commission before paying it.");
}

export async function voidApplicationCommission(tx: Tx, id: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new MoneyRuleError("A reason is required.");
  const res = await tx
    .update(applicationCommissions)
    .set({ status: "void", voidReason: reason.trim() })
    .where(eq(applicationCommissions.id, id))
    .returning({ id: applicationCommissions.id });
  if (res.length === 0) throw new MoneyRuleError("Commission not found.");
}

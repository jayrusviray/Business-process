import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  driverAccounts,
  ledgerEntries,
  paymentLines,
  payments,
  paymentVoids,
  remittancePayments,
  remittances,
} from "@/db/schema";
import { allocateAccount, type AccountAllocation, type EntryType } from "@/lib/ledger/allocation";
import type { IsoDate } from "@/lib/dates";
import { sum, ZERO, type Centavos } from "@/lib/money";
import { MoneyRuleError } from "./errors";
import { ensureAccount, lockDriver } from "./fleet";

export type PaymentMethod = "cash" | "gcash" | "maya" | "bank_transfer" | "other";

export type RecordPaymentInput = {
  /** Optional pre-generated id (lets a receipt photo be filed under the payment before insert). */
  id?: string;
  clientRequestId: string;
  driverId: string;
  method: PaymentMethod;
  referenceNo?: string | null;
  bankName?: string | null;
  receivedAt: Date;
  businessDate: IsoDate;
  collectorId: string;
  notes?: string;
  receiptDocumentId?: string | null;
  /** The collector's split across the driver's accounts. */
  lines: { accountId: string; amount: Centavos }[];
};

export type RecordedPayment = { id: string; receiptNo: string; duplicate: boolean };

/**
 * Records one payment: the payment row, one ledger credit per account line,
 * and the matching payment_lines. Idempotent on `clientRequestId`, so a
 * double-tap or network retry returns the original payment instead of posting twice.
 */
export async function recordPayment(tx: Tx, input: RecordPaymentInput): Promise<RecordedPayment> {
  const lines = input.lines.filter((l) => l.amount !== ZERO);
  if (lines.length === 0) throw new MoneyRuleError("Enter an amount for at least one account.");
  if (lines.some((l) => l.amount < ZERO)) throw new MoneyRuleError("Amounts must be positive.");
  if (new Set(lines.map((l) => l.accountId)).size !== lines.length) {
    throw new MoneyRuleError("Each account can appear only once in a payment.");
  }
  if (input.method !== "cash" && !input.referenceNo?.trim()) {
    throw new MoneyRuleError("A reference number is required for non-cash payments.");
  }

  await lockDriver(tx, input.driverId);

  const [existing] = await tx
    .select({ id: payments.id, receiptNo: payments.receiptNo })
    .from(payments)
    .where(eq(payments.clientRequestId, input.clientRequestId));
  if (existing) return { ...existing, duplicate: true };

  const accounts = await tx
    .select({ id: driverAccounts.id })
    .from(driverAccounts)
    .where(and(eq(driverAccounts.driverId, input.driverId), inArray(driverAccounts.id, lines.map((l) => l.accountId))));
  if (accounts.length !== lines.length) throw new MoneyRuleError("One of the accounts does not belong to this driver.");

  const total = sum(lines.map((l) => l.amount));
  const [payment] = await tx
    .insert(payments)
    .values({
      ...(input.id ? { id: input.id } : {}),
      clientRequestId: input.clientRequestId,
      driverId: input.driverId,
      amountCentavos: total,
      method: input.method,
      referenceNo: input.referenceNo?.trim() || null,
      bankName: input.bankName?.trim() || null,
      receivedAt: input.receivedAt,
      businessDate: input.businessDate,
      collectorId: input.collectorId,
      notes: input.notes ?? "",
      receiptDocumentId: input.receiptDocumentId ?? null,
    })
    .returning({ id: payments.id, receiptNo: payments.receiptNo });

  for (const line of lines) {
    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        accountId: line.accountId,
        driverId: input.driverId,
        entryType: "payment",
        amountCentavos: -line.amount,
        businessDate: input.businessDate,
        paymentId: payment.id,
        memo: `Payment ${payment.receiptNo}`,
      })
      .returning({ id: ledgerEntries.id });
    await tx.insert(paymentLines).values({
      paymentId: payment.id,
      accountId: line.accountId,
      amountCentavos: line.amount,
      ledgerEntryId: entry.id,
    });
  }
  return { ...payment, duplicate: false };
}

/** Voids a payment. The DB trigger posts the reversal entries in the same transaction. */
export async function voidPayment(tx: Tx, input: { paymentId: string; reason: string; voidedBy: string }): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required to void a payment.");
  const [p] = await tx.select({ driverId: payments.driverId }).from(payments).where(eq(payments.id, input.paymentId));
  if (!p) throw new MoneyRuleError("Payment not found.");
  await lockDriver(tx, p.driverId);
  const [already] = await tx.select().from(paymentVoids).where(eq(paymentVoids.paymentId, input.paymentId));
  if (already) throw new MoneyRuleError("This payment is already void.");
  await tx.insert(paymentVoids).values({ paymentId: input.paymentId, reason: input.reason.trim(), voidedBy: input.voidedBy });
}

/** Reverses any single ledger entry (a charge posted in error, etc.). Voids are for payments. */
export async function reverseEntry(
  tx: Tx,
  input: { entryId: string; reason: string; businessDate: IsoDate; allowBonus?: boolean },
): Promise<string> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const [orig] = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.id, input.entryId));
  if (!orig) throw new MoneyRuleError("Entry not found.");
  if (orig.entryType === "payment") throw new MoneyRuleError("Void the payment instead of reversing its entry.");
  if (orig.entryType === "bonus_credit" && !input.allowBonus) throw new MoneyRuleError("Void the bonus instead of reversing its entry.");
  if (orig.entryType === "reversal") throw new MoneyRuleError("A reversal cannot be reversed.");
  await lockDriver(tx, orig.driverId);
  const [dup] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.reversesEntryId, orig.id));
  if (dup) throw new MoneyRuleError("This entry is already reversed.");
  const [row] = await tx
    .insert(ledgerEntries)
    .values({
      accountId: orig.accountId,
      driverId: orig.driverId,
      entryType: "reversal",
      amountCentavos: -orig.amountCentavos,
      businessDate: input.businessDate,
      reversesEntryId: orig.id,
      reason: input.reason.trim(),
      memo: `Reversal of ${orig.entryType.replaceAll("_", " ")} ${orig.businessDate}`,
    })
    .returning({ id: ledgerEntries.id });
  return row.id;
}

/**
 * Manual adjustment (owner_admin/finance). Positive = driver owes more (due on `dueDate`),
 * negative = credit to the driver.
 */
export async function postAdjustment(
  tx: Tx,
  input: {
    accountId: string;
    amount: Centavos;
    reason: string;
    businessDate: IsoDate;
    dueDate?: IsoDate;
    type?: "adjustment" | "opening_balance";
  },
): Promise<string> {
  if (input.amount === ZERO) throw new MoneyRuleError("Amount cannot be zero.");
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const [acct] = await tx.select().from(driverAccounts).where(eq(driverAccounts.id, input.accountId));
  if (!acct) throw new MoneyRuleError("Account not found.");
  await lockDriver(tx, acct.driverId);
  const [row] = await tx
    .insert(ledgerEntries)
    .values({
      accountId: acct.id,
      driverId: acct.driverId,
      entryType: input.type ?? "adjustment",
      amountCentavos: input.amount,
      businessDate: input.businessDate,
      dueDate: input.amount > ZERO ? (input.dueDate ?? input.businessDate) : null,
      reason: input.reason.trim(),
      memo: input.type === "opening_balance" ? "Opening balance" : "Adjustment",
    })
    .returning({ id: ledgerEntries.id });
  return row.id;
}

/** Driver-borne cost (at cost) or the non-refundable deposit, on the driver's charges account. */
export async function postDriverCharge(
  tx: Tx,
  input: { driverId: string; kind: "cost_charge" | "deposit_charge"; amount: Centavos; dueDate: IsoDate; memo: string },
): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (!input.memo.trim()) throw new MoneyRuleError("Describe the charge (e.g. 'Change oil – receipt #123').");
  await lockDriver(tx, input.driverId);
  const accountId = await ensureAccount(tx, input.driverId, "charges", input.dueDate);
  const [row] = await tx
    .insert(ledgerEntries)
    .values({
      accountId,
      driverId: input.driverId,
      entryType: input.kind,
      amountCentavos: input.amount,
      businessDate: input.dueDate,
      dueDate: input.dueDate,
      memo: input.memo.trim(),
    })
    .returning({ id: ledgerEntries.id });
  return row.id;
}

export type AccountStatement = {
  account: { id: string; kind: "boundary" | "amortization" | "charges"; openedOn: string; closedOn: string | null };
  entries: (typeof ledgerEntries.$inferSelect)[];
  allocation: AccountAllocation;
};

/** All accounts of a driver with their entries and computed allocation (visible rows per RLS). */
export async function getDriverStatements(tx: Tx, driverId: string): Promise<AccountStatement[]> {
  const accounts = await tx
    .select({ id: driverAccounts.id, kind: driverAccounts.kind, openedOn: driverAccounts.openedOn, closedOn: driverAccounts.closedOn })
    .from(driverAccounts)
    .where(eq(driverAccounts.driverId, driverId))
    .orderBy(asc(driverAccounts.kind));
  if (accounts.length === 0) return [];
  const entries = await tx
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.driverId, driverId))
    .orderBy(asc(ledgerEntries.businessDate), asc(ledgerEntries.seq));
  return accounts.map((account) => {
    const own = entries.filter((e) => e.accountId === account.id);
    return {
      account,
      entries: own,
      allocation: allocateAccount(
        own.map((e) => ({
          id: e.id,
          seq: e.seq,
          entryType: e.entryType as EntryType,
          amount: e.amountCentavos,
          businessDate: e.businessDate as IsoDate,
          dueDate: e.dueDate as IsoDate | null,
          reversesEntryId: e.reversesEntryId,
        })),
      ),
    };
  });
}

/**
 * Records cash handed in by a collector. `expected` is the sum of the selected
 * unremitted, non-void cash payments collected by that collector; variance =
 * remitted − expected (negative = short).
 */
export async function createRemittance(
  tx: Tx,
  input: {
    collectorId: string;
    paymentIds: string[];
    remitted: Centavos;
    businessDate: IsoDate;
    receivedBy: string;
    notes?: string;
  },
): Promise<{ id: string; expected: Centavos; variance: Centavos }> {
  if (input.paymentIds.length === 0) throw new MoneyRuleError("Select at least one cash payment.");
  if (input.remitted < ZERO) throw new MoneyRuleError("Remitted amount cannot be negative.");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('transrev:remit:' || ${input.collectorId}))`);

  const rows = await tx.execute<{ id: string; amount_centavos: string }>(sql`
    SELECT p.id, p.amount_centavos FROM public.v_unremitted_cash p
    WHERE p.collector_id = ${input.collectorId}
      AND p.id IN (${sql.join(input.paymentIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  if (rows.length !== new Set(input.paymentIds).size) {
    throw new MoneyRuleError("Some payments are not unremitted cash collected by this collector.");
  }
  const expected = sum(rows.map((r) => BigInt(r.amount_centavos)));
  const [rem] = await tx
    .insert(remittances)
    .values({
      collectorId: input.collectorId,
      businessDate: input.businessDate,
      expectedCentavos: expected,
      remittedCentavos: input.remitted,
      receivedBy: input.receivedBy,
      notes: input.notes ?? "",
    })
    .returning({ id: remittances.id });
  await tx.insert(remittancePayments).values(rows.map((r) => ({ remittanceId: rem.id, paymentId: r.id })));
  return { id: rem.id, expected, variance: input.remitted - expected };
}

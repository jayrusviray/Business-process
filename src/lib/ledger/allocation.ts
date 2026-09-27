import { ZERO, type Centavos } from "@/lib/money";
import type { IsoDate } from "@/lib/dates";

/**
 * Allocation rule "oldest_due_first" (setting `ledger.allocation_strategy`),
 * applied WITHIN one account. Payments never move between accounts on their own;
 * the collector chooses the split at entry (owner rule, 2026-09-27).
 *
 *   1. A reversal and the entry it reverses cancel out; both are ignored.
 *   2. Remaining debits (amount > 0) are ordered by (dueDate, seq).
 *   3. All remaining credits (amount < 0) are pooled and fill the debits in that order.
 *   4. Any credit left over is an advance, applied automatically to later charges.
 *
 * Allocations are computed, never stored. That keeps them correct after
 * reversals and back-dated entries. The SQL view `v_charge_status` implements
 * the same rule; test/db/ledger.test.ts checks the two agree.
 */

export type EntryType =
  | "opening_balance"
  | "boundary_charge"
  | "amortization_charge"
  | "cost_charge"
  | "deposit_charge"
  | "payment"
  | "bonus_credit"
  | "adjustment"
  | "reversal";

export type LedgerEntryInput = {
  id: string;
  seq: bigint;
  entryType: EntryType;
  amount: Centavos;
  businessDate: IsoDate;
  dueDate: IsoDate | null;
  reversesEntryId: string | null;
};

export type ChargeStatus = "paid" | "partial" | "unpaid";

export type AllocatedCharge = {
  id: string;
  seq: bigint;
  entryType: EntryType;
  businessDate: IsoDate;
  dueDate: IsoDate;
  amount: Centavos;
  paid: Centavos;
  outstanding: Centavos;
  status: ChargeStatus;
};

export type AccountAllocation = {
  /** SUM of every entry: what the driver owes (negative = in advance). */
  balance: Centavos;
  charges: AllocatedCharge[];
  totalCredits: Centavos;
  /** Credit not yet applied to any charge (advance payment). */
  unappliedCredit: Centavos;
  totalOutstanding: Centavos;
};

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

function compareDebits(a: LedgerEntryInput, b: LedgerEntryInput): number {
  const da = a.dueDate!;
  const db = b.dueDate!;
  if (da !== db) return da < db ? -1 : 1;
  return a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1;
}

export function allocateAccount(entries: readonly LedgerEntryInput[]): AccountAllocation {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const reversed = new Set<string>();
  let balance = ZERO;

  for (const e of entries) {
    balance += e.amount;
    if (e.entryType === "reversal") {
      const original = e.reversesEntryId ? byId.get(e.reversesEntryId) : undefined;
      if (!original) throw new LedgerIntegrityError(`reversal ${e.id} references a missing entry`);
      if (original.amount !== -e.amount) throw new LedgerIntegrityError(`reversal ${e.id} amount mismatch`);
      if (reversed.has(original.id)) throw new LedgerIntegrityError(`entry ${original.id} reversed twice`);
      reversed.add(original.id);
    }
  }

  const active = entries.filter((e) => e.entryType !== "reversal" && !reversed.has(e.id));
  const debits = active.filter((e) => e.amount > ZERO).sort(compareDebits);
  const totalCredits = active.filter((e) => e.amount < ZERO).reduce((s, e) => s - e.amount, ZERO);

  let remaining = totalCredits;
  let totalOutstanding = ZERO;
  const charges: AllocatedCharge[] = debits.map((d) => {
    if (!d.dueDate) throw new LedgerIntegrityError(`debit ${d.id} has no due date`);
    const paid = remaining >= d.amount ? d.amount : remaining;
    remaining -= paid;
    const outstanding = d.amount - paid;
    totalOutstanding += outstanding;
    return {
      id: d.id,
      seq: d.seq,
      entryType: d.entryType,
      businessDate: d.businessDate,
      dueDate: d.dueDate,
      amount: d.amount,
      paid,
      outstanding,
      status: paid === d.amount ? "paid" : paid > ZERO ? "partial" : "unpaid",
    };
  });

  // Invariant: what is owed = outstanding charges − unused credit.
  if (balance !== totalOutstanding - remaining) {
    throw new LedgerIntegrityError(`balance ${balance} ≠ outstanding ${totalOutstanding} − credit ${remaining}`);
  }

  return { balance, charges, totalCredits, unappliedCredit: remaining, totalOutstanding };
}

/** Past-due charges of a type that are not fully paid as of a date (e.g. missed amortizations). */
export function countMissed(
  allocation: AccountAllocation,
  asOf: IsoDate,
  entryType: EntryType = "amortization_charge",
): number {
  return allocation.charges.filter((c) => c.entryType === entryType && c.dueDate < asOf && c.status !== "paid")
    .length;
}

/** Aging buckets by days past due (1–7, 8–30, 31+), as used by the aging report. */
export function ageOutstanding(
  allocation: AccountAllocation,
  asOf: IsoDate,
  daysPastDue: (due: IsoDate, asOf: IsoDate) => number,
): { current: Centavos; d1to7: Centavos; d8to30: Centavos; d31plus: Centavos } {
  const out = { current: ZERO, d1to7: ZERO, d8to30: ZERO, d31plus: ZERO };
  for (const c of allocation.charges) {
    if (c.outstanding === ZERO) continue;
    const days = daysPastDue(c.dueDate, asOf);
    if (days <= 0) out.current += c.outstanding;
    else if (days <= 7) out.d1to7 += c.outstanding;
    else if (days <= 30) out.d8to30 += c.outstanding;
    else out.d31plus += c.outstanding;
  }
  return out;
}

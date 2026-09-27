import { addMonths, type IsoDate } from "./dates";
import { ZERO, type Centavos } from "./money";

/**
 * RTO / boundary-hulog contracts. Owner rules (2026-09-27):
 *  - 5-year contract (term configurable per contract, default 60 months)
 *  - NO interest: installment = (price − down payment) ÷ term
 *  - cashout = remaining principal, no discounts/fees/minimums
 * Rounding: every installment is floor(financed ÷ term); the LAST installment
 * absorbs the remainder, so installments always sum exactly to the financed amount.
 */
export type RtoTerms = {
  contractPrice: Centavos;
  downPayment: Centavos;
  termMonths: number;
  startDate: IsoDate;
  firstDueDate: IsoDate;
};

export type Installment = { seq: number; dueDate: IsoDate; amount: Centavos; kind: "down_payment" | "installment" };

export function financedAmount(t: RtoTerms): Centavos {
  return t.contractPrice - t.downPayment;
}

export function monthlyAmortization(t: RtoTerms): Centavos {
  return financedAmount(t) / BigInt(t.termMonths);
}

export function validateTerms(t: RtoTerms): string | null {
  if (t.contractPrice <= ZERO) return "Contract price must be more than ₱0.00.";
  if (t.downPayment < ZERO || t.downPayment >= t.contractPrice) return "Down payment must be at least ₱0.00 and less than the contract price.";
  if (!Number.isInteger(t.termMonths) || t.termMonths < 1 || t.termMonths > 120) return "Term must be 1–120 months.";
  if (t.firstDueDate < t.startDate) return "The first due date can't be before the contract start.";
  return null;
}

/** Full payment plan: optional down payment (seq 0, due at start) + installments 1..term. */
export function rtoSchedule(t: RtoTerms): Installment[] {
  const out: Installment[] = [];
  if (t.downPayment > ZERO) out.push({ seq: 0, dueDate: t.startDate, amount: t.downPayment, kind: "down_payment" });
  const financed = financedAmount(t);
  const each = financed / BigInt(t.termMonths);
  const anchor = Number(t.firstDueDate.slice(8, 10));
  for (let i = 1; i <= t.termMonths; i++) {
    const amount = i === t.termMonths ? financed - each * BigInt(t.termMonths - 1) : each;
    out.push({ seq: i, dueDate: addMonths(t.firstDueDate, i - 1, anchor), amount, kind: "installment" });
  }
  return out;
}

/** Installments (incl. down payment) that fall due on `date`. */
export function installmentsDueOn(t: RtoTerms, date: IsoDate): Installment[] {
  return rtoSchedule(t).filter((i) => i.dueDate === date);
}

export type RtoProgress = {
  paid: Centavos;
  remaining: Centavos;
  percentPaid: number;
  installmentsFullyPaid: number;
  nextDue: Installment | null;
  scheduledCompletion: IsoDate;
  /** Installments due by `asOf` that the money received does not fully cover. */
  installmentsBehind: number;
};

/**
 * Progress from the net amount credited to the amortization account
 * (payments − voids − reversals + credit adjustments). Because there is no
 * interest, every peso received reduces the remaining principal one-for-one.
 */
export function rtoProgress(t: RtoTerms, netCredits: Centavos, asOf: IsoDate): RtoProgress {
  const schedule = rtoSchedule(t);
  const paid = netCredits < ZERO ? ZERO : netCredits > t.contractPrice ? t.contractPrice : netCredits;
  let covered = paid;
  let fully = 0;
  let behind = 0;
  let nextDue: Installment | null = null;
  for (const i of schedule) {
    if (covered >= i.amount) {
      covered -= i.amount;
      if (i.kind === "installment") fully++;
      continue;
    }
    covered = ZERO;
    if (i.dueDate < asOf) behind++;
    if (!nextDue) nextDue = i;
  }
  return {
    paid,
    remaining: t.contractPrice - paid,
    percentPaid: Number((paid * BigInt(10000)) / t.contractPrice) / 100,
    installmentsFullyPaid: fully,
    nextDue,
    scheduledCompletion: schedule[schedule.length - 1].dueDate,
    installmentsBehind: behind,
  };
}

/**
 * Cashout (early buyout) quote. Owner: remaining principal only, no discounts or fees.
 * `postedDebits` = amortization charges already posted (net of reversals);
 * the difference to the contract price is posted as a single payoff charge
 * when the cashout is completed, so the account nets to exactly zero.
 */
export function cashoutQuote(t: RtoTerms, postedDebits: Centavos, netCredits: Centavos) {
  const remainingPrincipal = t.contractPrice - netCredits;
  const unpostedPrincipal = t.contractPrice - postedDebits;
  return {
    remainingPrincipal: remainingPrincipal < ZERO ? ZERO : remainingPrincipal,
    arrears: postedDebits - netCredits > ZERO ? postedDebits - netCredits : ZERO,
    unpostedPrincipal,
    discount: ZERO,
    fees: ZERO,
    payoff: remainingPrincipal < ZERO ? ZERO : remainingPrincipal,
  };
}

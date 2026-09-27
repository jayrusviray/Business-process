import { addMonths, type IsoDate } from "./dates";
import { divRound, ZERO, type Centavos } from "./money";

/**
 * Diminishing-balance (annuity) amortization for bank/dealer vehicle loans
 * (owner, 2026-09-27). Monthly rate = annual ÷ 12. Level payment
 *   A = P·r / (1 − (1 + r)^−n)
 * computed in exact scaled-integer arithmetic (no floats), rounded half-up to
 * the centavo. Each month: interest = round(balance × r); principal = A − interest.
 * The final line pays off the exact remaining balance.
 */
export type LoanTerms = { principal: Centavos; annualRateBps: number; termMonths: number; firstDueDate: IsoDate };
export type LoanLine = {
  seq: number;
  dueDate: IsoDate;
  opening: Centavos;
  principal: Centavos;
  interest: Centavos;
  payment: Centavos;
  closing: Centavos;
};

const SCALE = BigInt(10) ** BigInt(24);
const MONTHLY_DENOM = BigInt(120_000); // bps ÷ 10,000 ÷ 12

export function levelPayment(t: Pick<LoanTerms, "principal" | "annualRateBps" | "termMonths">): Centavos {
  const n = t.termMonths;
  if (t.annualRateBps === 0) return divRound(t.principal, BigInt(n), "up");
  const rS = (BigInt(t.annualRateBps) * SCALE) / MONTHLY_DENOM; // r × SCALE (truncation error < 1e-24)
  let f = SCALE; // (1 + r)^n × SCALE
  for (let i = 0; i < n; i++) f = (f * (SCALE + rS)) / SCALE;
  return divRound(t.principal * rS * f, (f - SCALE) * SCALE);
}

export function loanSchedule(t: LoanTerms): LoanLine[] {
  const pay = levelPayment(t);
  const anchor = Number(t.firstDueDate.slice(8, 10));
  const lines: LoanLine[] = [];
  let balance = t.principal;
  for (let seq = 1; seq <= t.termMonths; seq++) {
    const interest = divRound(balance * BigInt(t.annualRateBps), MONTHLY_DENOM);
    let principal = pay - interest;
    if (seq === t.termMonths || principal > balance) principal = balance;
    if (principal < ZERO) principal = ZERO;
    lines.push({
      seq,
      dueDate: addMonths(t.firstDueDate, seq - 1, anchor),
      opening: balance,
      principal,
      interest,
      payment: principal + interest,
      closing: balance - principal,
    });
    balance -= principal;
    if (balance === ZERO) break;
  }
  return lines;
}

export type LoanLineStatus = LoanLine & { paid: Centavos; status: "paid" | "partial" | "unpaid"; overdue: boolean };

/** Applies total payments to schedule lines oldest-first. */
export function applyLoanPayments(lines: LoanLine[], totalPaid: Centavos, asOf: IsoDate): LoanLineStatus[] {
  let left = totalPaid;
  return lines.map((l) => {
    const paid = left >= l.payment ? l.payment : left > ZERO ? left : ZERO;
    left -= paid;
    const status = paid === l.payment ? "paid" : paid > ZERO ? "partial" : "unpaid";
    return { ...l, paid, status, overdue: status !== "paid" && l.dueDate < asOf };
  });
}

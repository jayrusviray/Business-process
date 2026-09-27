import { describe, expect, it } from "vitest";
import { isoDate } from "./dates";
import { pesos, sum } from "./money";
import { applyLoanPayments, levelPayment, loanSchedule } from "./loans";

const loan = { principal: pesos(1_000_000), annualRateBps: 1200, termMonths: 60, firstDueDate: isoDate("2026-10-15") };

describe("diminishing-balance loan", () => {
  it("level payment matches the annuity formula", () => {
    expect(levelPayment(loan)).toBe(BigInt(2_224_445)); // ₱22,244.45
    expect(levelPayment({ principal: pesos(850_000), annualRateBps: 1050, termMonths: 36 })).toBe(BigInt(2_762_708)); // ₱27,627.08
  });

  it("first line: interest on the full balance", () => {
    const [first] = loanSchedule(loan);
    expect(first).toEqual({
      seq: 1,
      dueDate: "2026-10-15",
      opening: pesos(1_000_000),
      interest: pesos(10_000),
      principal: BigInt(2_224_445) - pesos(10_000),
      payment: BigInt(2_224_445),
      closing: pesos(1_000_000) - (BigInt(2_224_445) - pesos(10_000)),
    });
  });

  it("principal portions sum exactly to the loan and the balance ends at zero", () => {
    const s = loanSchedule(loan);
    expect(s).toHaveLength(60);
    expect(sum(s.map((l) => l.principal))).toBe(loan.principal);
    expect(s[59].closing).toBe(BigInt(0));
    // Final payment only differs from the level payment by rounding.
    const diff = s[59].payment - s[0].payment;
    expect(diff >= BigInt(-100) && diff <= BigInt(100)).toBe(true);
    for (const l of s) expect(l.payment).toBe(l.principal + l.interest);
  });

  it("zero-interest loans split evenly", () => {
    const s = loanSchedule({ ...loan, annualRateBps: 0, termMonths: 3, principal: BigInt(100) });
    expect(s.map((l) => l.payment)).toEqual([BigInt(34), BigInt(34), BigInt(32)]);
  });

  it("payments apply to the oldest lines and flag overdue ones", () => {
    const s = loanSchedule(loan);
    const st = applyLoanPayments(s, s[0].payment + BigInt(100), isoDate("2026-12-01"));
    expect(st[0]).toMatchObject({ status: "paid", overdue: false });
    expect(st[1]).toMatchObject({ status: "partial", paid: BigInt(100), overdue: true });
    expect(st[2]).toMatchObject({ status: "unpaid", overdue: false });
  });
});

import { describe, expect, it } from "vitest";
import { isoDate } from "./dates";
import { pesos, sum } from "./money";
import { cashoutQuote, monthlyAmortization, rtoProgress, rtoSchedule, validateTerms, type RtoTerms } from "./rto";

const terms: RtoTerms = {
  contractPrice: pesos(900_000),
  downPayment: pesos(60_000),
  termMonths: 60,
  startDate: isoDate("2026-10-01"),
  firstDueDate: isoDate("2026-10-31"),
};

describe("RTO schedule (no interest)", () => {
  it("installment = (price − down) ÷ 60", () => {
    expect(monthlyAmortization(terms)).toBe(pesos(14_000));
    const s = rtoSchedule(terms);
    expect(s).toHaveLength(61);
    expect(s[0]).toEqual({ seq: 0, dueDate: "2026-10-01", amount: pesos(60_000), kind: "down_payment" });
    expect(s[1].dueDate).toBe("2026-10-31");
    expect(s[2].dueDate).toBe("2026-11-30"); // clamped
    expect(s[5].dueDate).toBe("2027-02-28");
    expect(s[6].dueDate).toBe("2027-03-31"); // back to the anchor day
    expect(s[60].dueDate).toBe("2031-09-30");
  });

  it("installments always sum exactly to the contract price (remainder in the last one)", () => {
    const odd = { ...terms, contractPrice: BigInt(100_000_001), downPayment: BigInt(0), termMonths: 60 };
    const s = rtoSchedule(odd);
    expect(sum(s.map((i) => i.amount))).toBe(odd.contractPrice);
    expect(s[0].amount).toBe(BigInt(1_666_666));
    expect(s[59].amount).toBe(BigInt(1_666_666) + BigInt(41));
  });

  it("validates terms", () => {
    expect(validateTerms(terms)).toBeNull();
    expect(validateTerms({ ...terms, downPayment: terms.contractPrice })).toMatch(/Down payment/);
    expect(validateTerms({ ...terms, termMonths: 0 })).toMatch(/Term/);
    expect(validateTerms({ ...terms, firstDueDate: isoDate("2026-09-01") })).toMatch(/first due/);
  });
});

describe("RTO progress", () => {
  it("counts money received against down payment first, then installments", () => {
    const p = rtoProgress(terms, pesos(60_000 + 14_000 * 2 + 5_000), isoDate("2027-01-15"));
    expect(p.installmentsFullyPaid).toBe(2);
    expect(p.remaining).toBe(pesos(900_000 - 93_000));
    expect(p.percentPaid).toBeCloseTo(10.33, 2);
    expect(p.nextDue).toMatchObject({ seq: 3, dueDate: "2026-12-31" });
    expect(p.installmentsBehind).toBe(1); // #3 due Dec 31 is short
    expect(p.scheduledCompletion).toBe("2031-09-30");
  });

  it("3 missed installments are detected", () => {
    const p = rtoProgress(terms, pesos(60_000), isoDate("2027-01-31"));
    expect(p.installmentsBehind).toBe(3); // Oct 31, Nov 30, Dec 31 (Jan 31 not yet past)
  });

  it("caps at the contract price", () => {
    const p = rtoProgress(terms, pesos(1_000_000), isoDate("2027-01-01"));
    expect(p).toMatchObject({ remaining: BigInt(0), percentPaid: 100, nextDue: null, installmentsFullyPaid: 60 });
  });
});

describe("cashout quote", () => {
  it("is the remaining principal, with no discount or fee", () => {
    // Posted: down payment + 3 installments; paid: down + 2 installments.
    const posted = pesos(60_000 + 14_000 * 3);
    const credits = pesos(60_000 + 14_000 * 2);
    const q = cashoutQuote(terms, posted, credits);
    expect(q).toEqual({
      remainingPrincipal: pesos(900_000 - 88_000),
      arrears: pesos(14_000),
      unpostedPrincipal: pesos(900_000 - 102_000),
      discount: BigInt(0),
      fees: BigInt(0),
      payoff: pesos(812_000),
    });
  });
});

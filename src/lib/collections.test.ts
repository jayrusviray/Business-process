import { describe, expect, it } from "vitest";
import { collectionRateBps, summarizeDay, type DayPayment } from "./collections";
import { pesos } from "./money";

const p = (over: Partial<DayPayment>): DayPayment => ({
  collectorId: "c1", collectorName: "Ana", method: "cash", amount: pesos(700), voided: false, remitted: false, ...over,
});

describe("summarizeDay", () => {
  it("splits cash, non-cash, remitted and unremitted per collector", () => {
    const s = summarizeDay([
      p({ amount: pesos(700), remitted: true }),
      p({ amount: pesos(500) }),
      p({ method: "gcash", amount: pesos(1000) }),
      p({ collectorId: "c2", collectorName: "Ben", amount: pesos(300) }),
    ]);
    expect(s.collectors.map((c) => [c.name, c.payments, c.collected, c.cash, c.nonCash, c.remitted, c.unremitted])).toEqual([
      ["Ana", 3, pesos(2200), pesos(1200), pesos(1000), pesos(700), pesos(500)],
      ["Ben", 1, pesos(300), pesos(300), BigInt(0), BigInt(0), pesos(300)],
    ]);
    expect([s.collected, s.cash, s.remitted, s.unremitted]).toEqual([pesos(2500), pesos(1500), pesos(700), pesos(800)]);
  });

  it("ignores voided payments", () => {
    const s = summarizeDay([p({ voided: true }), p({ amount: pesos(1), voided: true, remitted: true })]);
    expect(s.collectors).toEqual([]);
    expect(s.collected).toBe(BigInt(0));
  });
});

describe("collectionRateBps", () => {
  it("is collected ÷ charged, rounded down, and null with no charges", () => {
    expect(collectionRateBps(pesos(700), pesos(1400))).toBe(5000);
    expect(collectionRateBps(BigInt(1), BigInt(3))).toBe(3333);
    expect(collectionRateBps(pesos(2000), pesos(1000))).toBe(20000);
    expect(collectionRateBps(pesos(5), BigInt(0))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { applicationCommission, checklistProgress, expiryLevel, feeBalance, splitName } from "./applications";
import { pesos } from "./money";

describe("applicationCommission", () => {
  it("is null without an active rule", () => {
    expect(applicationCommission(null, pesos(5000))).toBeNull();
    expect(applicationCommission({ mode: "fixed", amountCentavos: pesos(500), rateBps: 0, active: false }, pesos(5000))).toBeNull();
  });
  it("pays a fixed amount regardless of fees", () => {
    expect(applicationCommission({ mode: "fixed", amountCentavos: pesos(500), rateBps: 0, active: true }, BigInt(0))).toEqual({ base: BigInt(0), amount: pesos(500) });
    expect(applicationCommission({ mode: "fixed", amountCentavos: BigInt(0), rateBps: 0, active: true }, pesos(10))).toBeNull();
  });
  it("pays a percentage of the fees, rounded half-up to the centavo", () => {
    expect(applicationCommission({ mode: "percent", amountCentavos: BigInt(0), rateBps: 1000, active: true }, pesos(8500))).toEqual({ base: pesos(8500), amount: pesos(850) });
    // 12.5% of ₱0.99 = 12.375 centavos → 12
    expect(applicationCommission({ mode: "percent", amountCentavos: BigInt(0), rateBps: 1250, active: true }, BigInt(99))?.amount).toBe(BigInt(12));
    // 12.5% of ₱1.00 = 12.5 centavos → 13 (half up)
    expect(applicationCommission({ mode: "percent", amountCentavos: BigInt(0), rateBps: 1250, active: true }, BigInt(100))?.amount).toBe(BigInt(13));
    expect(applicationCommission({ mode: "percent", amountCentavos: BigInt(0), rateBps: 1000, active: true }, BigInt(0))).toBeNull();
  });
});

describe("checklistProgress", () => {
  it("is complete when every required item is verified", () => {
    const now = new Date();
    expect(
      checklistProgress([
        { required: true, documentId: "d1", verifiedAt: now },
        { required: true, documentId: "d2", verifiedAt: null },
        { required: false, documentId: null, verifiedAt: null },
      ]),
    ).toEqual({ total: 3, submitted: 2, verified: 1, required: 2, verifiedRequired: 1, complete: false });
    expect(checklistProgress([{ required: true, documentId: null, verifiedAt: now }, { required: false, documentId: null, verifiedAt: null }]).complete).toBe(true);
    expect(checklistProgress([]).complete).toBe(true);
  });
});

describe("feeBalance", () => {
  it("ignores voided rows and can go negative when overpaid", () => {
    expect(
      feeBalance(
        [{ amount: pesos(5000), voided: false }, { amount: pesos(1000), voided: true }],
        [{ amount: pesos(2000), voided: false }, { amount: pesos(500), voided: true }],
      ),
    ).toEqual({ charged: pesos(5000), paid: pesos(2000), balance: pesos(3000) });
    expect(feeBalance([{ amount: pesos(100), voided: false }], [{ amount: pesos(150), voided: false }]).balance).toBe(pesos(-50));
  });
});

describe("splitName", () => {
  it("splits first and last names, keeping surname particles", () => {
    expect(splitName("Juan Dela Cruz")).toEqual({ firstName: "Juan", lastName: "Dela Cruz" });
    expect(splitName("Maria Clara de los Santos")).toEqual({ firstName: "Maria Clara", lastName: "de los Santos" });
    expect(splitName("  Pedro   Penduko ")).toEqual({ firstName: "Pedro", lastName: "Penduko" });
    expect(splitName("Madonna")).toEqual({ firstName: "", lastName: "Madonna" });
    expect(splitName("Ana Santa Maria")).toEqual({ firstName: "Ana", lastName: "Santa Maria" });
  });
});

describe("expiryLevel", () => {
  const today = "2026-10-01";
  it("grades expiries against the urgent and warning windows", () => {
    expect(expiryLevel(null, today, "2026-10-31", "2026-11-30")).toBeNull();
    expect(expiryLevel("2026-09-30", today, "2026-10-31", "2026-11-30")).toBe("expired");
    expect(expiryLevel("2026-10-31", today, "2026-10-31", "2026-11-30")).toBe("urgent");
    expect(expiryLevel("2026-11-30", today, "2026-10-31", "2026-11-30")).toBe("warn");
    expect(expiryLevel("2026-12-01", today, "2026-10-31", "2026-11-30")).toBeNull();
  });
});

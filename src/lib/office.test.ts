import { describe, expect, it } from "vitest";
import { isoDate } from "./dates";
import { pesos } from "./money";
import { investorShare, referralCommission } from "./office";

describe("referral commission", () => {
  it("10% of the down payment, payable one month after the contract starts", () => {
    expect(referralCommission(pesos(60_000), 1000, isoDate("2026-10-31"), 1)).toEqual({ amount: pesos(6_000), payableOn: "2026-11-30" });
    expect(referralCommission(BigInt(12_345), 1000, isoDate("2026-10-01"), 1).amount).toBe(BigInt(1_235)); // half-up
  });
});

describe("investor share", () => {
  it("22 × daily boundary − driver's monthly amortization", () => {
    expect(investorShare(pesos(700), pesos(12_000), 22)).toEqual({ computed: pesos(3_400), payable: pesos(3_400), negative: false });
  });
  it("no RTO contract → full 22 days", () => {
    expect(investorShare(pesos(800), BigInt(0), 22).payable).toBe(pesos(17_600));
  });
  it("negative results are flagged and paid as zero", () => {
    expect(investorShare(pesos(500), pesos(15_000), 22)).toEqual({ computed: -pesos(4_000), payable: BigInt(0), negative: true });
  });
});

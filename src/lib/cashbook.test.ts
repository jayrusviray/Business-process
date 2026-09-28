import { describe, expect, it } from "vitest";
import {
  collapseDriverPayments,
  compareCashRows,
  signed,
  isNonOperating,
  monthEndsBetween,
  reconciliationVariance,
  summarizeFlows,
  UNASSIGNED,
  withRunningBalances,
  type CashRow,
} from "./cashbook";
import { isoDate } from "./dates";
import { pesos, ZERO } from "./money";

const D = isoDate;
let n = 0;
function row(p: Partial<CashRow> & Pick<CashRow, "entryDate" | "direction" | "amount" | "category">): CashRow {
  n += 1;
  return {
    sourceType: "payment",
    sourceId: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    lineKey: "",
    accountId: "cash",
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, n)),
    ...p,
  };
}

describe("withRunningBalances", () => {
  it("starts from the opening balance and runs per account in book order", () => {
    const rows = [
      row({ entryDate: D("2026-09-02"), direction: "out", amount: pesos(300), category: "expense" }),
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(1_000), category: "boundary" }),
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(500), category: "boundary", accountId: "gcash" }),
      row({ entryDate: D("2026-09-03"), direction: "in", amount: pesos(50), category: "other_in" }),
    ];
    const { rows: out, closing } = withRunningBalances(new Map([["cash", pesos(200)]]), rows);
    expect(out.map((r) => [r.entryDate, r.accountId, r.balanceAfter])).toEqual([
      ["2026-09-01", "cash", pesos(1_200)],
      ["2026-09-01", "gcash", pesos(500)],
      ["2026-09-02", "cash", pesos(900)],
      ["2026-09-03", "cash", pesos(950)],
    ]);
    expect(closing.get("cash")).toBe(pesos(950));
    expect(closing.get("gcash")).toBe(pesos(500));
    // Input untouched.
    expect(rows[0].entryDate).toBe("2026-09-02");
  });

  it("orders same-day rows by the time they were recorded", () => {
    const early = row({ entryDate: D("2026-09-05"), direction: "out", amount: pesos(10), category: "expense", createdAt: "2026-09-05T01:00:00Z" });
    const late = row({ entryDate: D("2026-09-05"), direction: "in", amount: pesos(10), category: "boundary", createdAt: "2026-09-05T09:00:00Z" });
    const { rows: out } = withRunningBalances(new Map(), [late, early]);
    expect(out.map((r) => r.balanceAfter)).toEqual([pesos(-10), ZERO]);
    expect(compareCashRows(early, late)).toBeLessThan(0);
  });

  it("keeps a transfer's two legs on their own accounts, so the total never moves", () => {
    const out = row({ entryDate: D("2026-09-06"), direction: "out", amount: pesos(5_000), category: "transfer_out", accountId: "cash", lineKey: "out" });
    const inn = { ...out, direction: "in" as const, category: "transfer_in", accountId: "bank", lineKey: "in" };
    const { closing } = withRunningBalances(new Map([["cash", pesos(8_000)]]), [out, inn]);
    expect(closing.get("cash")).toBe(pesos(3_000));
    expect(closing.get("bank")).toBe(pesos(5_000));
    expect([...closing.values()].reduce((s, v) => s + v, ZERO)).toBe(pesos(8_000));
  });

  it("puts rows without an account under 'unassigned'", () => {
    const { closing } = withRunningBalances(new Map(), [row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(1), category: "boundary", accountId: null })]);
    expect(closing.get(UNASSIGNED)).toBe(pesos(1));
  });
});

describe("summarizeFlows", () => {
  it("excludes transfers and opening balances from in/out/net but reports them", () => {
    const s = summarizeFlows([
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(10_000), category: "opening_balance" }),
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(700), category: "boundary" }),
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(700), category: "boundary", accountId: "gcash" }),
      row({ entryDate: D("2026-09-02"), direction: "out", amount: pesos(250), category: "expense" }),
      row({ entryDate: D("2026-09-02"), direction: "out", amount: pesos(1_000), category: "transfer_out", lineKey: "out" }),
      row({ entryDate: D("2026-09-02"), direction: "in", amount: pesos(1_000), category: "transfer_in", accountId: "bank", lineKey: "in" }),
    ]);
    expect(s.totalIn).toBe(pesos(1_400));
    expect(s.totalOut).toBe(pesos(250));
    expect(s.net).toBe(pesos(1_150));
    expect(s.openingBalances).toBe(pesos(10_000));
    expect(s.transfersIn).toBe(pesos(1_000));
    expect(s.transfersOut).toBe(pesos(1_000));
    expect(s.byCategory.get("boundary")).toEqual({ in: pesos(1_400), out: ZERO, count: 2 });
    expect(s.byAccount.get("cash")).toEqual({ in: pesos(10_700), out: pesos(1_250) });
    expect(s.byAccount.get("bank")).toEqual({ in: pesos(1_000), out: ZERO });
  });

  it("an empty period is all zeros", () => {
    const s = summarizeFlows([]);
    expect([s.totalIn, s.totalOut, s.net]).toEqual([ZERO, ZERO, ZERO]);
  });

  it("flags non-operating categories", () => {
    expect(isNonOperating("transfer_in")).toBe(true);
    expect(isNonOperating("opening_balance")).toBe(true);
    expect(isNonOperating("boundary")).toBe(false);
  });
});

describe("collapseDriverPayments", () => {
  it("one line per day/account/category at the last payment, keeping exact balances", () => {
    const input = [
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(700), category: "boundary" }),
      row({ entryDate: D("2026-09-01"), direction: "out", amount: pesos(100), category: "expense", sourceType: "expense" }),
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(650), category: "boundary" }),
      row({ entryDate: D("2026-09-01"), direction: "in", amount: pesos(5_000), category: "rto" }),
      row({ entryDate: D("2026-09-02"), direction: "in", amount: pesos(700), category: "boundary" }),
    ];
    const { rows: withBal } = withRunningBalances(new Map(), input);
    const out = collapseDriverPayments(withBal);
    expect(out.map((r) => [r.entryDate, r.category, r.amount, r.count, r.balanceAfter])).toEqual([
      ["2026-09-01", "expense", pesos(100), 1, pesos(600)],
      ["2026-09-01", "boundary", pesos(1_350), 2, pesos(1_250)],
      ["2026-09-01", "rto", pesos(5_000), 1, pesos(6_250)],
      ["2026-09-02", "boundary", pesos(700), 1, pesos(6_950)],
    ]);
    expect(out.reduce((s, r) => s + signed(r), ZERO)).toBe(pesos(6_950));
  });
});

describe("reconciliation", () => {
  it("variance = counted − book", () => {
    expect(reconciliationVariance(pesos(9_500), pesos(10_000))).toBe(pesos(-500));
    expect(reconciliationVariance(pesos(10_000), pesos(10_000))).toBe(ZERO);
    expect(reconciliationVariance(BigInt(1), ZERO)).toBe(BigInt(1));
  });

  it("lists month ends in a range, including leap-year February", () => {
    expect(monthEndsBetween(D("2027-12-15"), D("2028-03-31"))).toEqual(["2027-12-31", "2028-01-31", "2028-02-29", "2028-03-31"]);
    expect(monthEndsBetween(D("2026-09-01"), D("2026-09-29"))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { daysBetween, isoDate, type IsoDate } from "@/lib/dates";
import { pesos, sum } from "@/lib/money";
import {
  ageOutstanding,
  allocateAccount,
  countMissed,
  LedgerIntegrityError,
  type EntryType,
  type LedgerEntryInput,
} from "./allocation";

let seq = BigInt(0);
function entry(
  entryType: EntryType,
  amount: bigint,
  date: string,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  seq += BigInt(1);
  return {
    id: `e${seq}`,
    seq,
    entryType,
    amount,
    businessDate: isoDate(date),
    dueDate: amount > BigInt(0) && entryType !== "reversal" ? isoDate(date) : null,
    reversesEntryId: null,
    ...extra,
  };
}
const charge = (date: string, p = 700) => entry("boundary_charge", pesos(p), date);
const payment = (date: string, p: number) => entry("payment", -pesos(p), date);
const reversalOf = (e: LedgerEntryInput, date: string) =>
  entry("reversal", -e.amount, date, { reversesEntryId: e.id });

describe("allocateAccount: oldest due first", () => {
  it("empty account", () => {
    const a = allocateAccount([]);
    expect(a).toMatchObject({ balance: BigInt(0), totalOutstanding: BigInt(0), unappliedCredit: BigInt(0) });
    expect(a.charges).toEqual([]);
  });

  it("exact payment clears the day", () => {
    const a = allocateAccount([charge("2026-10-01"), payment("2026-10-01", 700)]);
    expect(a.charges[0]).toMatchObject({ status: "paid", outstanding: BigInt(0) });
    expect(a.balance).toBe(BigInt(0));
  });

  it("partial payment leaves a shortage on that day", () => {
    const a = allocateAccount([charge("2026-10-01"), payment("2026-10-01", 500)]);
    expect(a.charges[0]).toMatchObject({ status: "partial", paid: pesos(500), outstanding: pesos(200) });
    expect(a.balance).toBe(pesos(200));
  });

  it("a late payment fills the oldest shortage first (carry-over)", () => {
    const a = allocateAccount([
      charge("2026-10-01"),
      payment("2026-10-01", 500),
      charge("2026-10-02"),
      payment("2026-10-02", 700),
    ]);
    // 1,200 paid against 1,400 due: day 1 is now fully paid, day 2 is short 200.
    expect(a.charges.map((c) => [c.dueDate, c.status, c.outstanding])).toEqual([
      ["2026-10-01", "paid", BigInt(0)],
      ["2026-10-02", "partial", pesos(200)],
    ]);
  });

  it("advance payments sit as credit and apply to later charges automatically", () => {
    const early = allocateAccount([payment("2026-10-01", 2100), charge("2026-10-01")]);
    expect(early.unappliedCredit).toBe(pesos(1400));
    expect(early.balance).toBe(-pesos(1400));
    const later = allocateAccount([
      payment("2026-10-01", 2100),
      charge("2026-10-01"),
      charge("2026-10-02"),
      charge("2026-10-03"),
      charge("2026-10-04"),
    ]);
    expect(later.charges.map((c) => c.status)).toEqual(["paid", "paid", "paid", "unpaid"]);
    expect(later.unappliedCredit).toBe(BigInt(0));
    expect(later.balance).toBe(pesos(700));
  });

  it("orders by due date, not by posting order (back-dated charge)", () => {
    const late = charge("2026-10-05");
    const backdated = entry("cost_charge", pesos(300), "2026-10-01");
    const a = allocateAccount([late, backdated, payment("2026-10-05", 300)]);
    expect(a.charges.map((c) => [c.dueDate, c.status])).toEqual([
      ["2026-10-01", "paid"],
      ["2026-10-05", "unpaid"],
    ]);
  });

  it("uses seq as the tie-breaker for the same due date", () => {
    const first = entry("cost_charge", pesos(100), "2026-10-01");
    const second = entry("deposit_charge", pesos(100), "2026-10-01");
    const a = allocateAccount([second, first, payment("2026-10-01", 100)].reverse());
    expect(a.charges.find((c) => c.id === first.id)?.status).toBe("paid");
    expect(a.charges.find((c) => c.id === second.id)?.status).toBe("unpaid");
  });

  it("a reversed charge disappears and its payment becomes credit", () => {
    const c1 = charge("2026-10-01");
    const a = allocateAccount([c1, payment("2026-10-01", 700), reversalOf(c1, "2026-10-02")]);
    expect(a.charges).toEqual([]);
    expect(a.unappliedCredit).toBe(pesos(700));
    expect(a.balance).toBe(-pesos(700));
  });

  it("a voided (reversed) payment re-opens the charges it covered", () => {
    const p = payment("2026-10-01", 700);
    const a = allocateAccount([charge("2026-10-01"), p, reversalOf(p, "2026-10-01")]);
    expect(a.charges[0].status).toBe("unpaid");
    expect(a.balance).toBe(pesos(700));
  });

  it("adjustments act as debits (+) or credits (−); opening balances too", () => {
    const a = allocateAccount([
      entry("opening_balance", pesos(5000), "2026-09-30"),
      entry("adjustment", -pesos(1000), "2026-10-01"),
      charge("2026-10-01"),
      payment("2026-10-01", 4000),
    ]);
    expect(a.charges.map((c) => [c.entryType, c.status])).toEqual([
      ["opening_balance", "paid"],
      ["boundary_charge", "unpaid"],
    ]);
    expect(a.balance).toBe(pesos(700));
  });

  it("bonus credits reduce what is owed", () => {
    const a = allocateAccount([charge("2026-10-01"), entry("bonus_credit", -pesos(700), "2026-10-31")]);
    expect(a.charges[0].status).toBe("paid");
  });

  it("rejects broken ledgers", () => {
    const c1 = charge("2026-10-01");
    expect(() => allocateAccount([entry("reversal", -c1.amount, "2026-10-01", { reversesEntryId: "missing" })])).toThrow(
      LedgerIntegrityError,
    );
    expect(() =>
      allocateAccount([c1, entry("reversal", -pesos(1), "2026-10-01", { reversesEntryId: c1.id })]),
    ).toThrow(/mismatch/);
    expect(() => allocateAccount([c1, reversalOf(c1, "2026-10-01"), reversalOf(c1, "2026-10-01")])).toThrow(/twice/);
  });

  it("property: balance = outstanding − unapplied credit, and paid never exceeds amount", () => {
    let r = 7;
    const rand = (n: number) => (r = (r * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 300; round++) {
      const entries: LedgerEntryInput[] = [];
      for (let i = 0; i < 1 + rand(40); i++) {
        const day = `2026-10-${String(1 + rand(28)).padStart(2, "0")}`;
        const kind = rand(10);
        if (kind < 5) entries.push(charge(day, 1 + rand(1500)));
        else if (kind < 9) entries.push(payment(day, 1 + rand(2000)));
        else if (entries.length) {
          const target = entries[rand(entries.length)];
          const already = entries.some((e) => e.reversesEntryId === target.id);
          if (target.entryType !== "reversal" && !already) entries.push(reversalOf(target, day));
        }
      }
      const a = allocateAccount(entries);
      expect(a.balance).toBe(sum(entries.map((e) => e.amount)));
      expect(a.balance).toBe(a.totalOutstanding - a.unappliedCredit);
      for (const c of a.charges) {
        expect(c.paid >= BigInt(0) && c.paid <= c.amount).toBe(true);
      }
      // FIFO: once a charge is not fully paid, every later charge is unpaid.
      const firstOpen = a.charges.findIndex((c) => c.status !== "paid");
      if (firstOpen >= 0) expect(a.charges.slice(firstOpen + 1).every((c) => c.status === "unpaid")).toBe(true);
    }
  });
});

describe("delinquency and aging", () => {
  const amort = (date: string) => entry("amortization_charge", pesos(15000), date);

  it("counts missed amortizations (past due and not fully paid)", () => {
    const a = allocateAccount([
      amort("2026-06-15"),
      amort("2026-07-15"),
      amort("2026-08-15"),
      amort("2026-09-15"),
      payment("2026-07-01", 20000), // covers June fully + part of July
    ]);
    expect(countMissed(a, isoDate("2026-09-27"))).toBe(3); // Jul (partial), Aug, Sep
    expect(countMissed(a, isoDate("2026-09-15"))).toBe(2); // Sep 15 not yet past due on its due date
  });

  it("ages outstanding amounts into 1–7, 8–30, 31+ buckets", () => {
    const a = allocateAccount([charge("2026-08-01"), charge("2026-09-20"), charge("2026-09-26"), charge("2026-09-27")]);
    const pastDue = (due: IsoDate, asOf: IsoDate) => daysBetween(due, asOf);
    expect(ageOutstanding(a, isoDate("2026-09-27"), pastDue)).toEqual({
      current: pesos(700),
      d1to7: pesos(1400),
      d8to30: BigInt(0),
      d31plus: pesos(700),
    });
  });
});

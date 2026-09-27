import { describe, expect, it } from "vitest";
import { isoDate } from "./dates";
import { pesos } from "./money";
import { planReminders, renderTemplate, smsHref, smsPeso, smsSegments, type DriverFacts, type RuleConfig } from "./reminders";

const rules: RuleConfig[] = [
  { trigger: "balance_weekly", active: true, weekday: 1, offsetDays: null, minAmount: BigInt(100) },
  { trigger: "missed_boundary", active: true, weekday: null, offsetDays: 1, minAmount: BigInt(1) },
  { trigger: "amortization_upcoming", active: true, weekday: null, offsetDays: 3, minAmount: BigInt(0) },
  { trigger: "amortization_missed", active: true, weekday: null, offsetDays: 1, minAmount: BigInt(0) },
  { trigger: "rto_milestone", active: true, weekday: null, offsetDays: null, minAmount: BigInt(0) },
  { trigger: "license_expiry", active: true, weekday: null, offsetDays: 30, minAmount: BigInt(0) },
];

const facts = (over: Partial<DriverFacts> = {}): DriverFacts => ({
  driverId: "d1",
  firstName: "Dante",
  phone: "09171234567",
  totalBalance: pesos(1400),
  boundaryDays: [],
  licenseExpiry: null,
  rto: null,
  ...over,
});

describe("templates", () => {
  it("renders variables and SMS-safe pesos", () => {
    expect(renderTemplate("Hi {{name}}, balance {{ balance }}", { name: "Dante", balance: smsPeso(pesos(1250)) })).toBe("Hi Dante, balance P1,250.00");
    expect(smsPeso(-BigInt(5))).toBe("-P0.05");
  });
  it("refuses to send unresolved variables", () => {
    expect(() => renderTemplate("Hi {{nme}}", { name: "x" })).toThrow(/nme/);
  });
  it("sms helpers", () => {
    expect(smsHref("0917 123 4567", "Hi & bye")).toBe("sms:09171234567?body=Hi%20%26%20bye");
    expect(smsSegments("x".repeat(160))).toBe(1);
    expect(smsSegments("x".repeat(161))).toBe(2);
  });
});

describe("planReminders", () => {
  it("weekly balance only on the configured weekday and above the minimum", () => {
    expect(planReminders(rules, facts(), isoDate("2026-09-28")).map((m) => m.trigger)).toEqual(["balance_weekly"]); // Monday
    expect(planReminders(rules, facts(), isoDate("2026-09-29"))).toEqual([]);
    expect(planReminders(rules, facts({ totalBalance: BigInt(0) }), isoDate("2026-09-28"))).toEqual([]);
  });

  it("missed boundary the next morning, once per day", () => {
    const f = facts({ boundaryDays: [{ dueDate: isoDate("2026-09-29"), amount: pesos(700), outstanding: pesos(200) }] });
    const m = planReminders(rules, f, isoDate("2026-09-30"));
    expect(m).toEqual([
      { trigger: "missed_boundary", dedupeKey: "missed_boundary:d1:2026-09-29", vars: { name: "Dante", balance: "P1,400.00", amount: "P700.00", date: "Sep 29, 2026" } },
    ]);
    const paid = facts({ boundaryDays: [{ dueDate: isoDate("2026-09-29"), amount: pesos(700), outstanding: BigInt(0) }] });
    expect(planReminders(rules, paid, isoDate("2026-09-30"))).toEqual([]);
  });

  it("amortization: 3 days before (upcoming), 1 day after if unpaid (missed)", () => {
    const rto = {
      contractNo: "RTO-00001",
      percentPaid: 10,
      missed: 1,
      installments: [
        { seq: 4, dueDate: isoDate("2026-10-30"), amount: pesos(12000), outstanding: null },
        { seq: 3, dueDate: isoDate("2026-09-30"), amount: pesos(12000), outstanding: pesos(2000) },
      ],
    };
    expect(planReminders(rules, facts({ rto }), isoDate("2026-10-27")).map((m) => [m.trigger, m.vars.amount])).toEqual([
      ["amortization_upcoming", "P12,000.00"],
    ]);
    expect(planReminders(rules, facts({ rto }), isoDate("2026-10-01")).map((m) => [m.trigger, m.vars.amount, m.vars.missed])).toEqual([
      ["amortization_missed", "P2,000.00", "1"],
    ]);
  });

  it("RTO milestones use the highest milestone reached", () => {
    const rto = { contractNo: "RTO-00001", percentPaid: 51.2, missed: 0, installments: [] };
    expect(planReminders(rules, facts({ rto, totalBalance: BigInt(0) }), isoDate("2026-10-01"))).toEqual([
      { trigger: "rto_milestone", dedupeKey: "rto_milestone:d1:RTO-00001:50", vars: { name: "Dante", balance: "P0.00", percent: "50", contract_no: "RTO-00001" } },
    ]);
  });

  it("license expiry within the window", () => {
    const f = facts({ licenseExpiry: isoDate("2026-10-20"), totalBalance: BigInt(0) });
    expect(planReminders(rules, f, isoDate("2026-09-21")).map((m) => m.vars.days)).toEqual(["29"]);
    expect(planReminders(rules, f, isoDate("2026-09-19"))).toEqual([]);
    expect(planReminders(rules, f, isoDate("2026-10-21"))).toEqual([]);
  });

  it("inactive rules produce nothing", () => {
    expect(planReminders(rules.map((r) => ({ ...r, active: false })), facts(), isoDate("2026-09-28"))).toEqual([]);
  });
});

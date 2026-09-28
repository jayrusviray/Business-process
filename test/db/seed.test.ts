import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { allocateAccount, type EntryType } from "@/lib/ledger/allocation";
import { DEMO_MARK, seedDemo, type DemoSummary } from "@/server/demo/seed";
import { withSystemTx } from "./app";
import { createUser, sql } from "./helpers";

const TODAY = isoDate("2026-09-27");
const mark = `${DEMO_MARK}%`;
let summary: DemoSummary;

beforeAll(async () => {
  await createUser("S Collector", ["operations"]);
  await createUser("S Finance", ["finance"]);
  await createUser("S Sales", ["sales"]);
  summary = await seedDemo((fn) => withSystemTx("seed:demo", fn), { today: TODAY });
}, 180_000);

afterAll(async () => {
  // Other test files assume they own every active employee and investor vehicle.
  await sql`UPDATE public.employees SET status = 'inactive', separation_date = ${TODAY} WHERE employee_no LIKE 'DEMO-%'`;
  await sql`UPDATE public.vehicles SET investor_id = NULL WHERE notes LIKE ${mark}`;
  await sql.end();
});

describe("demo seed", () => {
  it("creates the expected records", async () => {
    const [c] = await sql`
      SELECT
        (SELECT count(*)::int FROM public.drivers WHERE notes LIKE ${mark}) AS drivers,
        (SELECT count(*)::int FROM public.vehicles WHERE notes LIKE ${mark}) AS vehicles,
        (SELECT count(*)::int FROM public.vehicles WHERE notes LIKE ${mark} AND is_ev) AS evs,
        (SELECT count(*)::int FROM public.rto_contracts WHERE notes LIKE ${mark}) AS contracts,
        (SELECT count(*)::int FROM public.boundary_plans WHERE notes LIKE ${mark}) AS plans,
        (SELECT count(*)::int FROM public.employees WHERE employee_no LIKE 'DEMO-%') AS employees,
        (SELECT count(*)::int FROM public.investors WHERE notes LIKE ${mark}) AS investors,
        (SELECT count(*)::int FROM public.vehicles WHERE notes LIKE ${mark} AND investor_id IS NOT NULL) AS investor_vehicles,
        (SELECT count(*)::int FROM public.leads WHERE notes LIKE ${mark}) AS leads,
        (SELECT count(*)::int FROM public.applications WHERE notes LIKE ${mark}) AS applications,
        (SELECT count(*)::int FROM public.payments WHERE notes LIKE ${mark}) AS payments`;
    expect(c).toMatchObject({ drivers: 20, vehicles: 15, evs: 5, contracts: 5, plans: 17, employees: 5, investors: 2, investor_vehicles: 5, leads: 8, applications: 4 });
    expect(c.payments).toBe(summary.payments);
    expect(summary.payments).toBeGreaterThan(500);
  });

  it("has 60 days of daily charges with realistic arrears", async () => {
    const [r] = await sql`
      SELECT min(e.business_date)::text AS first, max(e.business_date)::text AS last, count(DISTINCT e.business_date)::int AS days
      FROM public.ledger_entries e JOIN public.drivers d ON d.id = e.driver_id
      WHERE d.notes LIKE ${mark} AND e.entry_type = 'boundary_charge'`;
    expect(r).toEqual({ first: "2026-07-29", last: "2026-09-27", days: 61 - Number((await sql`SELECT count(*)::int AS n FROM public.holidays WHERE date BETWEEN '2026-07-29' AND '2026-09-27'`)[0].n) });
    const statuses = await sql`
      SELECT cs.status, count(*)::int AS n FROM public.v_charge_status cs JOIN public.drivers d ON d.id = cs.driver_id
      WHERE d.notes LIKE ${mark} AND cs.entry_type = 'boundary_charge' GROUP BY 1`;
    const by = Object.fromEntries(statuses.map((s) => [s.status, s.n]));
    expect(by.paid).toBeGreaterThan(by.unpaid ?? 0);
    expect(by.unpaid ?? 0).toBeGreaterThan(0);
    const [run] = await sql`SELECT to_date::text AS t, status FROM public.charge_runs WHERE triggered_by = 'seed:demo'`;
    expect(run).toEqual({ t: "2026-09-27", status: "succeeded" });
  });

  it("every balance equals SUM(ledger) and the computed allocation", async () => {
    const accounts = await sql<{ id: string; balance: string }[]>`
      SELECT b.account_id AS id, b.balance_centavos::text AS balance FROM public.v_account_balances b
      JOIN public.drivers d ON d.id = b.driver_id WHERE d.notes LIKE ${mark}`;
    expect(accounts.length).toBeGreaterThan(30);
    for (const a of accounts) {
      const entries = await sql`SELECT * FROM public.ledger_entries WHERE account_id = ${a.id}`;
      const ledgerSum = entries.reduce((s, e) => s + BigInt(e.amount_centavos), BigInt(0));
      expect(ledgerSum).toBe(BigInt(a.balance));
      const alloc = allocateAccount(
        entries.map((e) => ({
          id: e.id, seq: BigInt(e.seq), entryType: e.entry_type as EntryType, amount: BigInt(e.amount_centavos),
          businessDate: e.business_date, dueDate: e.due_date, reversesEntryId: e.reverses_entry_id,
        })),
      );
      expect(alloc.balance).toBe(BigInt(a.balance));
      const [sqlOut] = await sql`SELECT coalesce(sum(outstanding_centavos), 0)::text AS o FROM public.v_charge_status WHERE account_id = ${a.id}`;
      expect(BigInt(sqlOut.o)).toBe(alloc.charges.reduce((s, ch) => s + ch.outstanding, BigInt(0)));
    }
  });

  it("refuses to run twice", async () => {
    await expect(seedDemo((fn) => withSystemTx("seed:demo", fn), { today: TODAY })).rejects.toThrow(/already/);
  });
});

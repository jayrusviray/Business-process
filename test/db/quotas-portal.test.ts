import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import { postBoundaryCharges } from "@/server/money/charges";
import { assignVehicle, startBoundaryPlan } from "@/server/money/fleet";
import { awardBonus, importQuotaCsv, upsertQuotaResult, voidBonus } from "@/server/money/quotas";
import { renderStatementPdf } from "@/server/pdf/statement";
import { getDriverOverview } from "@/server/queries/driver-overview";
import { as, schema, withSystemTx, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { drivers, vehicles, quotaRules, userRoles } = schema;
const D = isoDate;
let finance: string, ops: string, driverUser: string, otherUser: string;
let ruleId: string;

async function newDriver(phone: string, plate?: string, profileId?: string) {
  const id = await withUserTx(as(ops), async (tx) => {
    const [d] = await tx
      .insert(drivers)
      .values({ firstName: "Q", lastName: `Driver ${phone}`, phone, status: "active", profileId })
      .returning({ id: drivers.id });
    await startBoundaryPlan(tx, { driverId: d.id, programType: "boundary", dailyRate: pesos(700), effectiveFrom: D("2026-10-01") }, D("2026-10-01"));
    if (plate) {
      const [v] = await tx.insert(vehicles).values({ plateNo: plate, make: "Toyota", model: "Vios" }).returning({ id: vehicles.id });
      await assignVehicle(tx, { driverId: d.id, vehicleId: v.id, startDate: D("2026-10-01") });
    }
    return d.id;
  });
  return id;
}

beforeAll(async () => {
  finance = await createUser("Q Finance", ["finance"]);
  ops = await createUser("Q Ops", ["operations"]);
  driverUser = await createUser("Q Driver", []);
  otherUser = await createUser("Q Other", []);
  // The seeded rule: 200 rides / month, inactive until a bonus amount is set.
  const [seeded] = await sql`SELECT id, threshold, active FROM public.quota_rules WHERE name = 'Monthly ride quota'`;
  expect(seeded).toMatchObject({ threshold: "200", active: false });
  ruleId = seeded.id;
});

afterAll(async () => {
  await sql.end();
});

describe("quota rules", () => {
  it("cannot be activated without a bonus amount; finance activates it", async () => {
    await expectDbError(
      withUserTx(as(finance), (tx) => tx.update(quotaRules).set({ active: true }).where(eq(quotaRules.id, ruleId))),
      /quota_rules_active_needs_bonus/,
    );
    const r = await withUserTx(as(ops), (tx) =>
      tx.update(quotaRules).set({ bonusCentavos: pesos(1000), active: true }).where(eq(quotaRules.id, ruleId)).returning(),
    );
    expect(r.length).toBe(0); // operations can't change rules
    await withUserTx(as(finance), (tx) => tx.update(quotaRules).set({ bonusCentavos: pesos(1000), active: true }).where(eq(quotaRules.id, ruleId)));
  });
});

describe("results and CSV import", () => {
  it("upserts one result per driver per period", async () => {
    const d = await newDriver("09170000101");
    await withUserTx(as(ops), (tx) => upsertQuotaResult(tx, { ruleId, driverId: d, anyDateInPeriod: D("2026-10-15"), value: BigInt(150), source: "manual" }));
    await withUserTx(as(ops), (tx) => upsertQuotaResult(tx, { ruleId, driverId: d, anyDateInPeriod: D("2026-10-31"), value: BigInt(205), source: "manual" }));
    const rows = await sql`SELECT period_start::text s, period_end::text e, value FROM public.quota_results WHERE driver_id = ${d}`;
    expect(rows).toEqual([{ s: "2026-10-01", e: "2026-10-31", value: "205" }]);
  });

  it("previews then imports, matching by mobile or plate; any bad row blocks the import", async () => {
    const a = await newDriver("09170000201", "CSV 201");
    const b = await newDriver("09170000202", "CSV 202");
    const good = "Mobile Number,Total Trips\n+63 917 000 0201,210\n0917-000-0202,180\n";
    const preview = await withUserTx(as(ops), (tx) =>
      importQuotaCsv(tx, { ruleId, anyDateInPeriod: D("2026-10-01"), csvText: good, commit: false, fileName: "oct.csv" }),
    );
    expect(preview.rows.map((r) => [r.driverName?.includes("0201") || r.driverName?.includes("0202"), r.value, r.error])).toEqual([
      [true, BigInt(210), undefined],
      [true, BigInt(180), undefined],
    ]);
    expect(await sql`SELECT 1 FROM public.quota_results WHERE driver_id IN (${a}, ${b})`).toHaveLength(0);

    const bad = "plate,trips\nCSV 201,210\nNOPE 999,5\nCSV 202,abc\n";
    const p2 = await withUserTx(as(ops), (tx) =>
      importQuotaCsv(tx, { ruleId, anyDateInPeriod: D("2026-10-01"), csvText: bad, commit: false, fileName: "x.csv" }),
    );
    expect(p2.rows.map((r) => r.error ?? "ok")).toEqual(["ok", "No matching driver", '"abc" is not a whole number']);
    await expect(
      withUserTx(as(ops), (tx) => importQuotaCsv(tx, { ruleId, anyDateInPeriod: D("2026-10-01"), csvText: bad, commit: true, fileName: "x.csv" })),
    ).rejects.toThrow(/Fix 2 row/);

    const saved = await withUserTx(as(ops), (tx) =>
      importQuotaCsv(tx, { ruleId, anyDateInPeriod: D("2026-10-01"), csvText: good, commit: true, fileName: "oct.csv" }),
    );
    expect(saved.saved).toBe(2);
    const rows = await sql`SELECT value, source, source_note FROM public.quota_results WHERE driver_id = ${a}`;
    expect(rows).toEqual([{ value: "210", source: "csv", source_note: "oct.csv" }]);
  });

  it("rejects unknown CSV layouts with a helpful message", async () => {
    await expect(
      withUserTx(as(ops), (tx) => importQuotaCsv(tx, { ruleId, anyDateInPeriod: D("2026-10-01"), csvText: "name,count\nx,1", commit: false, fileName: "x" })),
    ).rejects.toThrow(/driver column/);
  });
});

describe("bonus awards", () => {
  async function hit(value: number) {
    const d = await newDriver(`0917${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`);
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-02")));
    const resultId = await withUserTx(as(ops), (tx) =>
      upsertQuotaResult(tx, { ruleId, driverId: d, anyDateInPeriod: D("2026-10-01"), value: BigInt(value), source: "manual" }),
    );
    return { d, resultId };
  }
  const bal = async (d: string) =>
    BigInt((await sql`SELECT balance_centavos FROM public.v_account_balances WHERE driver_id = ${d} AND kind = 'boundary'`)[0].balance_centavos);

  it("credit mode posts a bonus credit to the boundary balance", async () => {
    const { d, resultId } = await hit(200);
    expect(await bal(d)).toBe(pesos(700));
    await withUserTx(as(finance), (tx) => awardBonus(tx, { quotaResultId: resultId, mode: "credit", paidOn: D("2026-11-01") }));
    expect(await bal(d)).toBe(-pesos(300));
    await expect(withUserTx(as(finance), (tx) => awardBonus(tx, { quotaResultId: resultId, mode: "cash", paidOn: D("2026-11-01") }))).rejects.toThrow(/already awarded/);
    // Result is locked once awarded.
    await expectDbError(
      withUserTx(as(ops), (tx) => upsertQuotaResult(tx, { ruleId, driverId: d, anyDateInPeriod: D("2026-10-01"), value: BigInt(999), source: "manual" })),
      /already awarded/,
    );
  });

  it("cash mode records the payout without touching the ledger", async () => {
    const { d, resultId } = await hit(250);
    await withUserTx(as(finance), (tx) => awardBonus(tx, { quotaResultId: resultId, mode: "cash", paidOn: D("2026-11-01"), reference: "petty cash #12" }));
    expect(await bal(d)).toBe(pesos(700));
    const [a] = await sql`SELECT payout_mode, ledger_entry_id, amount_centavos FROM public.bonus_awards WHERE driver_id = ${d}`;
    expect(a).toEqual({ payout_mode: "cash", ledger_entry_id: null, amount_centavos: "100000" });
  });

  it("no bonus below the quota, and operations can't award", async () => {
    const low = await hit(199);
    await expect(withUserTx(as(finance), (tx) => awardBonus(tx, { quotaResultId: low.resultId, mode: "cash", paidOn: D("2026-11-01") }))).rejects.toThrow(/did not reach/);
    await expectDbError(
      sql`INSERT INTO public.bonus_awards (quota_result_id, driver_id, amount_centavos, payout_mode, paid_on) VALUES (${low.resultId}, ${low.d}, 100000, 'cash', '2026-11-01')`,
      /does not match a quota hit/,
    );
    const ok = await hit(200);
    await expect(withUserTx(as(ops), (tx) => awardBonus(tx, { quotaResultId: ok.resultId, mode: "cash", paidOn: D("2026-11-01") }))).rejects.toThrow();
  });

  it("voiding a credited bonus reverses the credit", async () => {
    const { d, resultId } = await hit(300);
    const awardId = await withUserTx(as(finance), (tx) => awardBonus(tx, { quotaResultId: resultId, mode: "credit", paidOn: D("2026-11-01") }));
    await withUserTx(as(finance), (tx) => voidBonus(tx, { awardId, reason: "count was wrong", userId: finance, businessDate: D("2026-11-02") }));
    expect(await bal(d)).toBe(pesos(700));
    await expect(withUserTx(as(finance), (tx) => voidBonus(tx, { awardId, reason: "again", userId: finance, businessDate: D("2026-11-02") }))).rejects.toThrow(/already void/);
    await expectDbError(sql`DELETE FROM public.bonus_awards WHERE id = ${awardId}`, /append-only/);
  });
});

describe("driver portal access", () => {
  it("operations can grant only the driver role, and only to a login linked to a driver", async () => {
    await expect(
      withUserTx(as(ops), (tx) => tx.insert(userRoles).values({ userId: driverUser, role: "driver" })),
    ).rejects.toThrow(); // not linked yet
    const d = await newDriver("09170000301", "PRT 301");
    await withUserTx(as(ops), async (tx) => {
      await tx.update(drivers).set({ profileId: driverUser }).where(eq(drivers.id, d));
      await tx.insert(userRoles).values({ userId: driverUser, role: "driver", grantedBy: ops });
    });
    await expect(withUserTx(as(ops), (tx) => tx.insert(userRoles).values({ userId: driverUser, role: "finance" }))).rejects.toThrow();
    await expect(withUserTx(as(ops), (tx) => tx.insert(userRoles).values({ userId: otherUser, role: "driver" }))).rejects.toThrow();
  });

  it("the driver sees their own overview, vehicle, results and bonuses; nobody else's", async () => {
    const [me] = await sql`SELECT id FROM public.drivers WHERE profile_id = ${driverUser}`;
    const someoneElse = await newDriver("09170000302", "PRT 302");
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-03")));
    await withUserTx(as(ops), (tx) => upsertQuotaResult(tx, { ruleId, driverId: me.id, anyDateInPeriod: D("2026-10-03"), value: BigInt(120), source: "manual" }));

    const mine = await withUserTx(as(driverUser), (tx) => getDriverOverview(tx, me.id, D("2026-10-03")));
    expect(mine?.assignment?.plateNo).toBe("PRT 301");
    expect(mine?.todayCharge?.amount).toBe(pesos(700));
    expect(mine?.quotas[0]).toMatchObject({ value: BigInt(120), recorded: true });
    expect(mine?.nextDue?.date).toBe("2026-10-04");

    expect(await withUserTx(as(driverUser), (tx) => getDriverOverview(tx, someoneElse, D("2026-10-03")))).toBeNull();
    const visible = await withUserTx(as(driverUser), async (tx) => ({
      vehicles: await tx.execute(dsql`SELECT plate_no FROM public.vehicles`),
      results: await tx.execute(dsql`SELECT DISTINCT driver_id FROM public.quota_results`),
      awards: await tx.execute(dsql`SELECT DISTINCT driver_id FROM public.bonus_awards`),
    }));
    expect(visible.vehicles.map((v) => v.plate_no)).toEqual(["PRT 301"]);
    expect(visible.results.map((r) => r.driver_id)).toEqual([me.id]);
    expect(visible.awards.every((r) => r.driver_id === me.id)).toBe(true);
  });

  it("next due skips holidays", async () => {
    const [me] = await sql`SELECT id FROM public.drivers WHERE profile_id = ${driverUser}`;
    const o = await withUserTx(as(driverUser), (tx) => getDriverOverview(tx, me.id, D("2026-11-29")));
    expect(o?.nextDue?.date).toBe("2026-12-01"); // Nov 30 is Bonifacio Day
  });

  it("renders a statement of account PDF under the driver's RLS", async () => {
    const [me] = await sql`SELECT id FROM public.drivers WHERE profile_id = ${driverUser}`;
    const pdf = await withUserTx(as(driverUser), (tx) => renderStatementPdf(tx, me.id, D("2026-10-01"), D("2026-10-31")));
    expect(pdf?.subarray(0, 5).toString()).toBe("%PDF-");
    const other = await newDriver("09170000303");
    expect(await withUserTx(as(driverUser), (tx) => renderStatementPdf(tx, other, D("2026-10-01"), D("2026-10-31")))).toBeNull();
  });
});

describe("holidays", () => {
  it("regular holidays are seeded", async () => {
    const rows = await sql`SELECT date::text d FROM public.holidays WHERE date BETWEEN '2026-12-01' AND '2027-01-01' ORDER BY 1`;
    expect(rows.map((r) => r.d)).toEqual(["2026-12-25", "2026-12-30", "2027-01-01"]);
  });
});


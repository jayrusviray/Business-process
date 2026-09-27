import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, isoDate, type IsoDate } from "@/lib/dates";
import { allocateAccount, type EntryType } from "@/lib/ledger/allocation";
import { pesos } from "@/lib/money";
import { runDailyCharges, postBoundaryCharges } from "@/server/money/charges";
import {
  assignVehicle,
  endBoundaryPlan,
  ensureAccount,
  startBoundaryPlan,
} from "@/server/money/fleet";
import {
  createRemittance,
  getDriverStatements,
  postAdjustment,
  postDriverCharge,
  recordPayment,
  reverseEntry,
  voidPayment,
} from "@/server/money/payments";
import { as, schema, withSystemTx, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { drivers, vehicles, ledgerEntries, holidays, boundaryPlans } = schema;
const D = isoDate;

let admin: string, finance: string, ops: string, ops2: string, sales: string, driverUser: string;

async function newDriver(status: "active" | "suspended" = "active", profileId?: string) {
  return withUserTx(as(ops), async (tx) => {
    const [d] = await tx
      .insert(drivers)
      .values({ firstName: "Juan", lastName: `Dela Cruz ${crypto.randomUUID().slice(0, 6)}`, phone: "09170000000", status, profileId })
      .returning({ id: drivers.id });
    return d.id;
  });
}

async function newVehicle() {
  return withUserTx(as(ops), async (tx) => {
    const [v] = await tx
      .insert(vehicles)
      .values({ plateNo: `ABC ${Math.floor(Math.random() * 1e6)}`, make: "BYD", model: "e6", isEv: true })
      .returning({ id: vehicles.id });
    return v.id;
  });
}

async function planFor(driverId: string, from: IsoDate, rate = 700) {
  return withUserTx(as(ops), (tx) =>
    startBoundaryPlan(tx, { driverId, programType: "boundary", dailyRate: pesos(rate), effectiveFrom: from }, from),
  );
}

async function boundaryAccount(driverId: string) {
  return withUserTx(as(ops), (tx) => ensureAccount(tx, driverId, "boundary", D("2026-01-01")));
}

async function balance(driverId: string, kind = "boundary") {
  const [r] = await sql`SELECT balance_centavos FROM public.v_account_balances WHERE driver_id = ${driverId} AND kind = ${kind}`;
  return BigInt(r?.balance_centavos ?? 0);
}

beforeAll(async () => {
  admin = await createUser("M Admin", ["owner_admin"]);
  finance = await createUser("M Finance", ["finance"]);
  ops = await createUser("M Ops", ["operations"]);
  ops2 = await createUser("M Ops 2", ["operations"]);
  sales = await createUser("M Sales", ["sales"]);
  driverUser = await createUser("M Driver", ["driver"]);
});

afterAll(async () => {
  await sql.end();
});

describe("daily boundary charges", () => {
  it("posts one charge per active plan per day, stamped with the assigned vehicle", async () => {
    const d = await newDriver();
    const v = await newVehicle();
    await planFor(d, D("2026-10-01"));
    await withUserTx(as(ops), (tx) => assignVehicle(tx, { driverId: d, vehicleId: v, startDate: D("2026-10-01") }));
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-01")));
    const rows = await sql`SELECT amount_centavos, vehicle_id, due_date::text FROM public.ledger_entries WHERE driver_id = ${d}`;
    expect(rows).toEqual([{ amount_centavos: "70000", vehicle_id: v, due_date: "2026-10-01" }]);
  });

  it("is idempotent: re-running a day never double-charges", async () => {
    const d = await newDriver();
    await planFor(d, D("2026-10-01"));
    for (let i = 0; i < 3; i++) await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-02")));
    expect(await balance(d)).toBe(pesos(700));
  });

  it("does not charge on holidays, before the plan starts, after it ends, or for non-active drivers", async () => {
    const d = await newDriver();
    const suspended = await newDriver("suspended");
    await planFor(d, D("2026-10-10"));
    await planFor(suspended, D("2026-10-10"));
    await withUserTx(as(admin), (tx) => tx.insert(holidays).values({ date: "2026-10-12", name: "Test holiday" }));
    await withSystemTx("test", async (tx) => {
      for (const day of ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]) {
        await postBoundaryCharges(tx, D(day));
      }
    });
    await withUserTx(as(ops), (tx) => endBoundaryPlan(tx, d, D("2026-10-13")));
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-14")));
    const days = await sql`SELECT business_date::text AS d FROM public.ledger_entries WHERE driver_id = ${d} ORDER BY 1`;
    expect(days.map((r) => r.d)).toEqual(["2026-10-10", "2026-10-11", "2026-10-13"]);
    expect(await balance(suspended)).toBe(BigInt(0));
  });

  it("runDailyCharges catches up missed days and records the run", async () => {
    // Far-future dates: other test files share this DB and run the job for earlier dates.
    await sql`SELECT set_config('app.actor_label', 'test', false)`;
    const d = await newDriver();
    await planFor(d, D("2030-11-01"));
    const first = await withSystemTx("cron:test", (tx) => runDailyCharges(tx, D("2030-11-01"), "cron:test"));
    expect(first.fromDate <= "2030-11-01").toBe(true);
    // Job "fails" to run for 3 days; the next run back-fills 11-02..11-05.
    const second = await withSystemTx("cron:test", (tx) => runDailyCharges(tx, D("2030-11-05"), "cron:test"));
    expect([second.fromDate, second.toDate]).toEqual(["2030-11-02", "2030-11-05"]);
    expect(await balance(d)).toBe(pesos(700 * 5));
    // Same-day rerun is harmless.
    const third = await withSystemTx("cron:test", (tx) => runDailyCharges(tx, D("2030-11-05"), "cron:test"));
    expect(third.chargesPosted).toBe(0);
    const [run] = await sql`SELECT status, triggered_by FROM public.charge_runs ORDER BY started_at DESC LIMIT 1`;
    expect(run).toEqual({ status: "succeeded", triggered_by: "cron:test" });
  });

  it("users cannot post boundary charges directly", async () => {
    const d = await newDriver();
    const acct = await boundaryAccount(d);
    await expect(
      withUserTx(as(admin), (tx) =>
        tx.insert(ledgerEntries).values({
          accountId: acct, driverId: d, entryType: "boundary_charge", amountCentavos: pesos(1),
          businessDate: "2026-10-01", dueDate: "2026-10-01",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("boundary plans", () => {
  it("a rate change ends the old plan the day before and starts a new version", async () => {
    const d = await newDriver();
    await planFor(d, D("2026-10-01"), 700);
    await planFor(d, D("2026-10-15"), 750);
    const plans = await sql`SELECT daily_rate_centavos, effective_from::text f, effective_to::text t FROM public.boundary_plans WHERE driver_id = ${d} ORDER BY effective_from`;
    expect(plans).toEqual([
      { daily_rate_centavos: "70000", f: "2026-10-01", t: "2026-10-14" },
      { daily_rate_centavos: "75000", f: "2026-10-15", t: null },
    ]);
  });

  it("plans cannot be edited, cannot start in the past, and cannot end before posted charges", async () => {
    const d = await newDriver();
    const planId = await planFor(d, D("2026-10-01"));
    // Column privileges only allow effective_to/notes; the guard trigger backs this up for the owner role.
    await expectDbError(
      withUserTx(as(finance), (tx) => tx.update(boundaryPlans).set({ dailyRateCentavos: pesos(1) }).where(eq(boundaryPlans.id, planId))),
      /permission denied/,
    );
    await expect(sql`UPDATE public.boundary_plans SET daily_rate_centavos = 1 WHERE id = ${planId}`).rejects.toThrow(/versioned/);
    await expect(
      withUserTx(as(ops), (tx) =>
        startBoundaryPlan(tx, { driverId: d, programType: "boundary", dailyRate: pesos(700), effectiveFrom: D("2026-09-01") }, D("2026-10-01")),
      ),
    ).rejects.toThrow(/past/);
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-03")));
    await expectDbError(withUserTx(as(ops), (tx) => endBoundaryPlan(tx, d, D("2026-10-02"))), /already posted/);
  });
});

describe("vehicle assignments", () => {
  it("reassigning ends previous assignments; overlaps are impossible", async () => {
    const d1 = await newDriver();
    const d2 = await newDriver();
    const v = await newVehicle();
    await withUserTx(as(ops), (tx) => assignVehicle(tx, { driverId: d1, vehicleId: v, startDate: D("2026-10-01") }));
    await withUserTx(as(ops), (tx) => assignVehicle(tx, { driverId: d2, vehicleId: v, startDate: D("2026-10-20") }));
    const rows = await sql`SELECT driver_id, start_date::text s, end_date::text e FROM public.vehicle_assignments WHERE vehicle_id = ${v} ORDER BY start_date`;
    expect(rows).toEqual([
      { driver_id: d1, s: "2026-10-01", e: "2026-10-19" },
      { driver_id: d2, s: "2026-10-20", e: null },
    ]);
    await expect(
      sql`INSERT INTO public.vehicle_assignments (vehicle_id, driver_id, start_date) VALUES (${v}, ${d1}, '2026-10-25')`,
    ).rejects.toThrow(/assignments_no_vehicle_overlap/);
  });
});

describe("payments", () => {
  async function setup() {
    const d = await newDriver();
    await planFor(d, D("2026-10-01"));
    await withSystemTx("test", async (tx) => {
      for (const day of ["2026-10-01", "2026-10-02", "2026-10-03"]) await postBoundaryCharges(tx, D(day));
    });
    const boundary = await boundaryAccount(d);
    const charges = await withUserTx(as(ops), (tx) => ensureAccount(tx, d, "charges", D("2026-10-01")));
    return { d, boundary, charges };
  }

  const pay = (driverId: string, lines: { accountId: string; amount: bigint }[], extra: Record<string, unknown> = {}) => ({
    clientRequestId: crypto.randomUUID(),
    driverId,
    method: "cash" as const,
    receivedAt: new Date("2026-10-03T02:00:00Z"),
    businessDate: D("2026-10-03"),
    collectorId: ops,
    lines,
    ...extra,
  });

  it("the collector splits one payment across accounts; each account gets its own credit", async () => {
    const { d, boundary, charges } = await setup();
    await withUserTx(as(ops), (tx) =>
      postDriverCharge(tx, { driverId: d, kind: "deposit_charge", amount: pesos(5000), dueDate: D("2026-10-01"), memo: "Deposit" }),
    );
    const p = await withUserTx(as(ops), (tx) =>
      recordPayment(tx, pay(d, [{ accountId: boundary, amount: pesos(1400) }, { accountId: charges, amount: pesos(2000) }])),
    );
    expect(p.receiptNo).toMatch(/^AR-\d{6}$/);
    expect(await balance(d, "boundary")).toBe(pesos(700));
    expect(await balance(d, "charges")).toBe(pesos(3000));
    const [row] = await sql`SELECT amount_centavos, created_by FROM public.payments WHERE id = ${p.id}`;
    expect(row).toEqual({ amount_centavos: "340000", created_by: ops });
  });

  it("is idempotent on clientRequestId (double tap / retry)", async () => {
    const { d, boundary } = await setup();
    const input = pay(d, [{ accountId: boundary, amount: pesos(700) }]);
    const a = await withUserTx(as(ops), (tx) => recordPayment(tx, input));
    const b = await withUserTx(as(ops), (tx) => recordPayment(tx, input));
    expect(b).toEqual({ ...a, duplicate: true });
    expect(await balance(d)).toBe(pesos(1400));
  });

  it("concurrent submissions of the same payment post once", async () => {
    const { d, boundary } = await setup();
    const input = pay(d, [{ accountId: boundary, amount: pesos(100) }]);
    const results = await Promise.allSettled([
      withUserTx(as(ops), (tx) => recordPayment(tx, input)),
      withUserTx(as(ops), (tx) => recordPayment(tx, input)),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const rows = await sql`SELECT count(*)::int n FROM public.payments WHERE client_request_id = ${input.clientRequestId}`;
    expect(rows[0].n).toBe(1);
  });

  it("rejects bad input: non-cash without reference, another driver's account, empty", async () => {
    const { d, boundary } = await setup();
    const other = await setup();
    await expect(
      withUserTx(as(ops), (tx) => recordPayment(tx, pay(d, [{ accountId: boundary, amount: pesos(1) }], { method: "gcash" }))),
    ).rejects.toThrow(/reference/);
    await expect(
      withUserTx(as(ops), (tx) => recordPayment(tx, pay(d, [{ accountId: other.boundary, amount: pesos(1) }]))),
    ).rejects.toThrow(/does not belong/);
    await expect(withUserTx(as(ops), (tx) => recordPayment(tx, pay(d, [])))).rejects.toThrow(/at least one/);
  });

  it("the database rejects a payment whose lines don't add up (even bypassing the service)", async () => {
    const { d, boundary } = await setup();
    await expect(
      sql.begin(async (tx) => {
        const [p] = await tx`INSERT INTO public.payments (driver_id, amount_centavos, method, received_at, business_date, collector_id, client_request_id)
          VALUES (${d}, 50000, 'cash', now(), '2026-10-03', ${ops}, gen_random_uuid()) RETURNING id`;
        const [e] = await tx`INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, payment_id)
          VALUES (${boundary}, ${d}, 'payment', -40000, '2026-10-03', ${p.id}) RETURNING id`;
        await tx`INSERT INTO public.payment_lines (payment_id, account_id, amount_centavos, ledger_entry_id) VALUES (${p.id}, ${boundary}, 40000, ${e.id})`;
      }),
    ).rejects.toThrow(/lines total/);
  });

  it("sales and drivers cannot record payments", async () => {
    const { d, boundary } = await setup();
    await expect(withUserTx(as(sales), (tx) => recordPayment(tx, pay(d, [{ accountId: boundary, amount: pesos(1) }])))).rejects.toThrow();
    await expect(withUserTx(as(driverUser), (tx) => recordPayment(tx, pay(d, [{ accountId: boundary, amount: pesos(1) }])))).rejects.toThrow();
  });

  it("finance can void a payment; the credits are reversed and the charges re-open", async () => {
    const { d, boundary } = await setup();
    const p = await withUserTx(as(ops), (tx) => recordPayment(tx, pay(d, [{ accountId: boundary, amount: pesos(2100) }])));
    expect(await balance(d)).toBe(BigInt(0));
    await expect(withUserTx(as(ops), (tx) => voidPayment(tx, { paymentId: p.id, reason: "wrong driver", voidedBy: ops }))).rejects.toThrow();
    await withUserTx(as(finance), (tx) => voidPayment(tx, { paymentId: p.id, reason: "wrong driver", voidedBy: finance }));
    expect(await balance(d)).toBe(pesos(2100));
    await expect(withUserTx(as(finance), (tx) => voidPayment(tx, { paymentId: p.id, reason: "again", voidedBy: finance }))).rejects.toThrow(/already void/);
    const [rev] = await sql`SELECT reason, created_by FROM public.ledger_entries WHERE entry_type = 'reversal' AND driver_id = ${d}`;
    expect(rev).toEqual({ reason: "wrong driver", created_by: finance });
  });
});

describe("corrections", () => {
  it("finance reverses a charge posted in error; operations cannot; nobody can edit or delete", async () => {
    const d = await newDriver();
    await planFor(d, D("2026-10-01"));
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-01")));
    const [c] = await sql`SELECT id FROM public.ledger_entries WHERE driver_id = ${d}`;
    await expect(withUserTx(as(ops), (tx) => reverseEntry(tx, { entryId: c.id, reason: "x", businessDate: D("2026-10-02") }))).rejects.toThrow();
    await withUserTx(as(finance), (tx) => reverseEntry(tx, { entryId: c.id, reason: "Driver was on approved leave", businessDate: D("2026-10-02") }));
    expect(await balance(d)).toBe(BigInt(0));
    await expect(withUserTx(as(finance), (tx) => reverseEntry(tx, { entryId: c.id, reason: "x", businessDate: D("2026-10-02") }))).rejects.toThrow(/already reversed/);
    await expect(sql`UPDATE public.ledger_entries SET amount_centavos = 1 WHERE id = ${c.id}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM public.ledger_entries WHERE id = ${c.id}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM public.payments`).rejects.toThrow(/append-only/);
  });

  it("the database rejects malformed reversals and reasonless adjustments", async () => {
    const d = await newDriver();
    await planFor(d, D("2026-10-01"));
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-01")));
    const [c] = await sql`SELECT id, account_id FROM public.ledger_entries WHERE driver_id = ${d}`;
    await expect(
      sql`INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, reverses_entry_id, reason)
          VALUES (${c.account_id}, ${d}, 'reversal', -1, '2026-10-02', ${c.id}, 'x')`,
    ).rejects.toThrow(/opposite amount/);
    await expect(
      sql`INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date)
          VALUES (${c.account_id}, ${d}, 'adjustment', 100, '2026-10-02', '2026-10-02')`,
    ).rejects.toThrow(/ledger_reason_required/);
    await expect(
      sql`INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date)
          VALUES (${c.account_id}, ${d}, 'cost_charge', 100, '2026-10-02', '2026-10-02')`,
    ).rejects.toThrow(/cannot be posted to a boundary account/);
  });

  it("adjustments and opening balances are finance/admin only", async () => {
    const d = await newDriver();
    const acct = await boundaryAccount(d);
    await expect(
      withUserTx(as(ops), (tx) => postAdjustment(tx, { accountId: acct, amount: -pesos(100), reason: "goodwill", businessDate: D("2026-10-01") })),
    ).rejects.toThrow();
    await withUserTx(as(finance), (tx) =>
      postAdjustment(tx, { accountId: acct, amount: pesos(12000), reason: "Spreadsheet balance at cutover", businessDate: D("2026-09-30"), type: "opening_balance" }),
    );
    expect(await balance(d)).toBe(pesos(12000));
  });
});

describe("remittances", () => {
  it("tracks expected vs remitted cash per collector and prevents double remittance", async () => {
    const d = await newDriver();
    await planFor(d, D("2026-10-01"));
    const acct = await boundaryAccount(d);
    const mk = (collector: string, amount: number, method: "cash" | "gcash" = "cash") =>
      withUserTx(as(collector), (tx) =>
        recordPayment(tx, {
          clientRequestId: crypto.randomUUID(), driverId: d, method, referenceNo: method === "cash" ? null : "GC123",
          receivedAt: new Date(), businessDate: D("2026-10-05"), collectorId: collector, lines: [{ accountId: acct, amount: pesos(amount) }],
        }),
      );
    const p1 = await mk(ops2, 700);
    const p2 = await mk(ops2, 500);
    const gcash = await mk(ops2, 300, "gcash");
    const other = await mk(ops, 100);

    // A collector can't remit to themselves (finance/admin receive cash).
    await expect(
      withUserTx(as(ops2), (tx) => createRemittance(tx, { collectorId: ops2, paymentIds: [p1.id], remitted: pesos(700), businessDate: D("2026-10-05"), receivedBy: ops2 })),
    ).rejects.toThrow();
    // Non-cash or someone else's payments are rejected.
    for (const ids of [[gcash.id], [other.id]]) {
      await expect(
        withUserTx(as(finance), (tx) => createRemittance(tx, { collectorId: ops2, paymentIds: ids, remitted: pesos(1), businessDate: D("2026-10-05"), receivedBy: finance })),
      ).rejects.toThrow(/not unremitted cash/);
    }
    const r = await withUserTx(as(finance), (tx) =>
      createRemittance(tx, { collectorId: ops2, paymentIds: [p1.id, p2.id], remitted: pesos(1150), businessDate: D("2026-10-05"), receivedBy: finance }),
    );
    expect(r.expected).toBe(pesos(1200));
    expect(r.variance).toBe(-pesos(50));
    await expect(
      withUserTx(as(finance), (tx) => createRemittance(tx, { collectorId: ops2, paymentIds: [p1.id], remitted: pesos(700), businessDate: D("2026-10-05"), receivedBy: finance })),
    ).rejects.toThrow(/not unremitted cash/);

    // Collectors see only their own remittances.
    const seen = await withUserTx(as(ops), (tx) => tx.execute(dsql`SELECT id FROM public.remittances`));
    expect(seen.length).toBe(0);
    const own = await withUserTx(as(ops2), (tx) => tx.execute(dsql`SELECT id FROM public.remittances`));
    expect(own.length).toBe(1);
  });
});

describe("driver self-access (RLS)", () => {
  it("a driver linked to a login sees only their own ledger, payments and accounts", async () => {
    const mine = await newDriver("active", driverUser);
    const theirs = await newDriver();
    for (const d of [mine, theirs]) {
      await planFor(d, D("2026-10-01"));
    }
    await withSystemTx("test", (tx) => postBoundaryCharges(tx, D("2026-10-01")));
    const rows = await withUserTx(as(driverUser), async (tx) => ({
      drivers: await tx.execute(dsql`SELECT id FROM public.drivers`),
      ledger: await tx.execute(dsql`SELECT DISTINCT driver_id FROM public.ledger_entries`),
      balances: await tx.execute(dsql`SELECT driver_id FROM public.v_account_balances`),
      status: await tx.execute(dsql`SELECT DISTINCT driver_id FROM public.v_charge_status`),
      vehicles: await tx.execute(dsql`SELECT id FROM public.vehicles`),
    }));
    expect(rows.drivers.map((r) => r.id)).toEqual([mine]);
    expect(rows.ledger.map((r) => r.driver_id)).toEqual([mine]);
    expect([...new Set(rows.balances.map((r) => r.driver_id))]).toEqual([mine]);
    expect(rows.status.map((r) => r.driver_id)).toEqual([mine]);
    expect(rows.vehicles.length).toBe(0);
  });

  it("disabling the driver's login removes access", async () => {
    await sql`UPDATE public.profiles SET status = 'disabled' WHERE id = ${driverUser}`;
    try {
      const rows = await withUserTx(as(driverUser), (tx) => tx.execute(dsql`SELECT id FROM public.ledger_entries`));
      expect(rows.length).toBe(0);
    } finally {
      await sql`UPDATE public.profiles SET status = 'active' WHERE id = ${driverUser}`;
    }
  });
});

describe("allocation: SQL view matches the TypeScript engine", () => {
  it("fills by due date, not posting order (back-dated debit)", async () => {
    const d = await newDriver();
    await planFor(d, D("2027-01-04"));
    const acct = await boundaryAccount(d);
    await withSystemTx("test", async (tx) => {
      for (const day of ["2027-01-04", "2027-01-05"]) await postBoundaryCharges(tx, D(day));
    });
    // Posted last, but due first.
    await withUserTx(as(finance), (tx) =>
      postAdjustment(tx, { accountId: acct, amount: pesos(500), reason: "towing", businessDate: D("2027-01-05"), dueDate: D("2027-01-03") }),
    );
    await withUserTx(as(ops), (tx) =>
      recordPayment(tx, {
        clientRequestId: crypto.randomUUID(), driverId: d, method: "cash", receivedAt: new Date(),
        businessDate: D("2027-01-05"), collectorId: ops, lines: [{ accountId: acct, amount: pesos(700) }],
      }),
    );
    const view = await sql`SELECT entry_type, due_date::text due, paid_centavos, status FROM public.v_charge_status WHERE account_id = ${acct} ORDER BY due_date, seq`;
    expect(view).toEqual([
      { entry_type: "adjustment", due: "2027-01-03", paid_centavos: "50000", status: "paid" },
      { entry_type: "boundary_charge", due: "2027-01-04", paid_centavos: "20000", status: "partial" },
      { entry_type: "boundary_charge", due: "2027-01-05", paid_centavos: "0", status: "unpaid" },
    ]);
  });

  it("agrees on paid/outstanding for a random ledger with reversals, voids and back-dated entries", async () => {
    const d = await newDriver();
    await planFor(d, D("2026-12-01"));
    const acct = await boundaryAccount(d);
    let r = 11;
    const rand = (n: number) => (r = (r * 1103515245 + 12345) % 2147483648) % n;
    const start = D("2026-12-01");
    const paymentIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      await withSystemTx("test", (tx) => postBoundaryCharges(tx, addDays(start, i)));
      if (rand(3) === 0) {
        const p = await withUserTx(as(ops), (tx) =>
          recordPayment(tx, {
            clientRequestId: crypto.randomUUID(), driverId: d, method: "cash", receivedAt: new Date(),
            businessDate: addDays(start, i), collectorId: ops, lines: [{ accountId: acct, amount: BigInt(1 + rand(150000)) }],
          }),
        );
        paymentIds.push(p.id);
      }
      if (rand(6) === 0) {
        await withUserTx(as(finance), (tx) =>
          postAdjustment(tx, { accountId: acct, amount: BigInt(1 + rand(50000)), reason: "back-dated", businessDate: addDays(start, i), dueDate: addDays(start, rand(i + 1)) }),
        );
      }
    }
    if (paymentIds.length) {
      await withUserTx(as(finance), (tx) => voidPayment(tx, { paymentId: paymentIds[0], reason: "test", voidedBy: finance }));
    }
    const [someCharge] = await sql`SELECT id FROM public.ledger_entries WHERE account_id = ${acct} AND entry_type = 'boundary_charge' ORDER BY seq DESC LIMIT 1`;
    await withUserTx(as(finance), (tx) => reverseEntry(tx, { entryId: someCharge.id, reason: "test", businessDate: D("2026-12-26") }));

    const [statement] = (await withUserTx(as(finance), (tx) => getDriverStatements(tx, d))).filter((s) => s.account.kind === "boundary");
    const view = await sql`SELECT entry_id, paid_centavos, outstanding_centavos, status FROM public.v_charge_status WHERE account_id = ${acct} ORDER BY due_date, seq`;
    expect(view.map((v) => [v.entry_id, BigInt(v.paid_centavos), BigInt(v.outstanding_centavos), v.status])).toEqual(
      statement.allocation.charges.map((c) => [c.id, c.paid, c.outstanding, c.status]),
    );
    expect(await balance(d)).toBe(statement.allocation.balance);

    // Cross-check against the pure engine fed straight from SQL.
    const raw = await sql`SELECT id, seq, entry_type, amount_centavos, business_date::text bd, due_date::text dd, reverses_entry_id FROM public.ledger_entries WHERE account_id = ${acct}`;
    const pure = allocateAccount(
      raw.map((e) => ({
        id: e.id, seq: BigInt(e.seq), entryType: e.entry_type as EntryType, amount: BigInt(e.amount_centavos),
        businessDate: D(e.bd), dueDate: e.dd ? D(e.dd) : null, reversesEntryId: e.reverses_entry_id,
      })),
    );
    expect(pure.balance).toBe(statement.allocation.balance);
  });
});

describe("audit coverage", () => {
  it("money tables write audit rows with the actor", async () => {
    const d = await newDriver();
    const rows = await sql`SELECT table_name, actor_id FROM public.audit_log WHERE row_pk = ${d}`;
    expect(rows).toContainEqual({ table_name: "drivers", actor_id: ops });
  });

  it("every money table has RLS and anon has no access", async () => {
    const rows = await sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`;
    expect(rows).toEqual([]);
    const grants = await sql`SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema = 'public'`;
    expect(grants).toEqual([]);
  });
});

import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import { runDailyCharges } from "@/server/money/charges";
import { ensureAccount } from "@/server/money/fleet";
import { createVehicleLoan, getLoanStatus, loanDueAlerts, recordLoanPayment, reverseLoanPayment } from "@/server/money/loans";
import { postDriverCharge, recordPayment } from "@/server/money/payments";
import { closePaidContract, createRtoContract, getRtoStatus, terminateContract } from "@/server/money/rto";
import { as, schema, withSystemTx, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { drivers, vehicles, rtoContracts } = schema;
const D = isoDate;
let finance: string, ops: string, driverUser: string;

async function setup(opts: { downPayment?: number; price?: number; start?: string; firstDue?: string; profileId?: string } = {}) {
  const ids = await withUserTx(as(ops), async (tx) => {
    const [d] = await tx.insert(drivers).values({ firstName: "R", lastName: `T ${crypto.randomUUID().slice(0, 5)}`, phone: "09175550000", status: "active", profileId: opts.profileId }).returning({ id: drivers.id });
    const [v] = await tx.insert(vehicles).values({ plateNo: `RTO ${Math.floor(Math.random() * 1e6)}`, make: "BYD", model: "Dolphin", powertrain: "ev" }).returning({ id: vehicles.id });
    return { d: d.id, v: v.id };
  });
  const contractId = await withUserTx(as(finance), (tx) =>
    createRtoContract(
      tx,
      {
        driverId: ids.d,
        vehicleId: ids.v,
        contractPrice: pesos(opts.price ?? 900_000),
        downPayment: pesos(opts.downPayment ?? 60_000),
        termMonths: 60,
        startDate: D(opts.start ?? "2026-10-01"),
        firstDueDate: D(opts.firstDue ?? "2026-10-31"),
      },
      D(opts.start ?? "2026-10-01"),
    ),
  );
  const [c] = await sql`SELECT account_id FROM public.rto_contracts WHERE id = ${contractId}`;
  return { ...ids, contractId, account: c.account_id as string };
}

const pay = (driverId: string, accountId: string, amount: bigint, day = "2026-10-01") =>
  withUserTx(as(ops), (tx) =>
    recordPayment(tx, { clientRequestId: crypto.randomUUID(), driverId, method: "cash", receivedAt: new Date(), businessDate: D(day), collectorId: ops, lines: [{ accountId, amount }] }),
  );

beforeAll(async () => {
  finance = await createUser("R Finance", ["finance"]);
  ops = await createUser("R Ops", ["operations"]);
  driverUser = await createUser("R Driver", ["driver"]);
});
afterAll(async () => {
  await sql.end();
});

describe("RTO contracts", () => {
  it("creates an amortization account and posts the down payment on signing", async () => {
    const { contractId, account } = await setup();
    const rows = await sql`SELECT entry_type, amount_centavos, due_date::text d, memo FROM public.ledger_entries WHERE account_id = ${account}`;
    expect(rows).toEqual([{ entry_type: "amortization_charge", amount_centavos: "6000000", d: "2026-10-01", memo: expect.stringMatching(/^Down payment – RTO-\d{5}$/) }]);
    const [c] = await sql`SELECT contract_no, status FROM public.rto_contracts WHERE id = ${contractId}`;
    expect(c.status).toBe("active");
  });

  it("the daily job posts installments on their due dates (idempotent, not skipped on holidays)", async () => {
    const { account } = await setup({ start: "2026-11-01", firstDue: "2026-11-30" }); // Nov 30 = Bonifacio Day
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2026-11-30"), "test"));
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2026-11-30"), "test"));
    const rows = await sql`SELECT amount_centavos, due_date::text d FROM public.ledger_entries WHERE account_id = ${account} AND memo LIKE 'Amortization%'`;
    expect(rows).toEqual([{ amount_centavos: "1400000", d: "2026-11-30" }]);
  });

  it("contracts signed before go-live catch up past installments and take an opening credit", async () => {
    const ids = await withUserTx(as(ops), async (tx) => {
      const [d] = await tx.insert(drivers).values({ firstName: "Old", lastName: "Contract", phone: "09175550001", status: "active" }).returning({ id: drivers.id });
      const [v] = await tx.insert(vehicles).values({ plateNo: "OLD 0001", make: "Toyota", model: "Wigo" }).returning({ id: vehicles.id });
      return { d: d.id, v: v.id };
    });
    const id = await withUserTx(as(finance), (tx) =>
      createRtoContract(tx, { driverId: ids.d, vehicleId: ids.v, contractPrice: pesos(600_000), downPayment: pesos(0), termMonths: 60, startDate: D("2026-06-15"), firstDueDate: D("2026-07-15"), paidBeforeGoLive: pesos(30_000) }, D("2026-10-01")),
    );
    const s = await withUserTx(as(finance), (tx) => getRtoStatus(tx, id, D("2026-10-01")));
    // 3 installments (Jul, Aug, Sep) of 10,000 posted; 30,000 already paid.
    expect(s!.progress).toMatchObject({ installmentsFullyPaid: 3, installmentsBehind: 0, remaining: pesos(570_000) });
    expect(s!.missed).toBe(0);
  });

  it("partial amortization payments are accepted; missed installments are counted", async () => {
    const { d, contractId, account } = await setup();
    await pay(d, account, pesos(60_000)); // down payment
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2027-01-31"), "test"));
    await pay(d, account, pesos(5_000), "2027-01-31"); // partial on installment #1
    const s = await withUserTx(as(finance), (tx) => getRtoStatus(tx, contractId, D("2027-02-01")));
    expect(s!.missed).toBe(4); // Oct, Nov, Dec, Jan all not fully paid
    expect(s!.progress.remaining).toBe(pesos(900_000 - 65_000));
  });

  it("only finance/admin create contracts; terms are immutable; one active contract per vehicle", async () => {
    const { d, v, contractId } = await setup();
    await expect(
      withUserTx(as(ops), (tx) => createRtoContract(tx, { driverId: d, vehicleId: v, contractPrice: pesos(1), downPayment: BigInt(0), termMonths: 1, startDate: D("2026-10-01"), firstDueDate: D("2026-10-01") }, D("2026-10-01"))),
    ).rejects.toThrow();
    await expectDbError(sql`UPDATE public.rto_contracts SET contract_price_centavos = 1 WHERE id = ${contractId}`, /terms cannot be changed/);
    const other = await withUserTx(as(ops), async (tx) => {
      const [x] = await tx.insert(drivers).values({ firstName: "X", lastName: "Y", phone: "09175550002", status: "active" }).returning({ id: drivers.id });
      return x.id;
    });
    await expectDbError(
      withUserTx(as(finance), (tx) => createRtoContract(tx, { driverId: other, vehicleId: v, contractPrice: pesos(100), downPayment: BigInt(0), termMonths: 2, startDate: D("2026-10-01"), firstDueDate: D("2026-10-01") }, D("2026-10-01"))),
      /rto_one_active_per_vehicle/,
    );
  });

  it("cashout = remaining principal: blocked until paid, then posts the payoff and transfers the vehicle", async () => {
    const { d, v, contractId, account } = await setup();
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2026-12-01"), "test"));
    const before = await withUserTx(as(finance), (tx) => getRtoStatus(tx, contractId, D("2026-12-01")));
    expect(before!.quote).toMatchObject({ remainingPrincipal: pesos(900_000), discount: BigInt(0), fees: BigInt(0) });
    await expect(withUserTx(as(finance), (tx) => closePaidContract(tx, contractId, D("2026-12-01")))).rejects.toThrow(/still owes ₱900,000.00/);

    // Other balances must be clear too (setting rto.cashout_requires_clear_balances = true).
    await withUserTx(as(ops), (tx) => postDriverCharge(tx, { driverId: d, kind: "cost_charge", amount: pesos(1500), dueDate: D("2026-11-15"), memo: "Tire" }));
    await pay(d, account, pesos(900_000), "2026-12-01");
    await expect(withUserTx(as(finance), (tx) => closePaidContract(tx, contractId, D("2026-12-01")))).rejects.toThrow(/charges ₱1,500.00/);
    const charges = await withUserTx(as(ops), (tx) => ensureAccount(tx, d, "charges", D("2026-10-01")));
    await pay(d, charges, pesos(1500), "2026-12-01");

    await expect(withUserTx(as(ops), (tx) => closePaidContract(tx, contractId, D("2026-12-01")))).rejects.toThrow();
    const result = await withUserTx(as(finance), (tx) => closePaidContract(tx, contractId, D("2026-12-01")));
    expect(result).toBe("cashed_out");
    const [bal] = await sql`SELECT balance_centavos, closed_on::text c FROM public.v_account_balances WHERE account_id = ${account}`;
    expect(bal).toEqual({ balance_centavos: "0", c: "2026-12-01" });
    const [veh] = await sql`SELECT status FROM public.vehicles WHERE id = ${v}`;
    expect(veh.status).toBe("transferred");
    // No more installments after closing.
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2027-01-31"), "test"));
    const [b2] = await sql`SELECT balance_centavos FROM public.v_account_balances WHERE account_id = ${account}`;
    expect(b2.balance_centavos).toBe("0");
    await expectDbError(sql`UPDATE public.rto_contracts SET status = 'active', closed_on = NULL WHERE id = ${contractId}`, /cannot be reopened/);
  });

  it("termination stops future installments but keeps arrears", async () => {
    const { contractId, account } = await setup();
    await withUserTx(as(finance), (tx) => terminateContract(tx, contractId, "Vehicle repossessed", D("2026-10-15")));
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2026-12-31"), "test"));
    const [b] = await sql`SELECT balance_centavos FROM public.v_account_balances WHERE account_id = ${account}`;
    expect(b.balance_centavos).toBe("6000000"); // unpaid down payment still owed
  });

  it("the driver sees their own contract", async () => {
    const mine = await setup({ profileId: driverUser });
    await setup();
    const rows = await withUserTx(as(driverUser), (tx) => tx.select({ id: rtoContracts.id }).from(rtoContracts));
    expect(rows.map((r) => r.id)).toEqual([mine.contractId]);
    const s = await withUserTx(as(driverUser), (tx) => getRtoStatus(tx, mine.contractId, D("2026-10-01")));
    expect(s?.progress.remaining).toBe(pesos(900_000));
  });
});

describe("vehicle loans (diminishing balance)", () => {
  async function newLoan() {
    const v = await withUserTx(as(ops), async (tx) => {
      const [x] = await tx.insert(vehicles).values({ plateNo: `LN ${Math.floor(Math.random() * 1e6)}`, make: "Toyota", model: "Vios", fundingSource: "financed" }).returning({ id: vehicles.id });
      return x.id;
    });
    const loanId = await withUserTx(as(finance), (tx) =>
      createVehicleLoan(tx, { vehicleId: v, lender: "BDO", principal: pesos(1_000_000), annualRateBps: 1200, termMonths: 60, firstDueDate: D("2026-10-15") }),
    );
    return { v, loanId };
  }

  it("stores the generated schedule; the DB checks every line's arithmetic", async () => {
    const { loanId } = await newLoan();
    const lines = await sql`SELECT seq, payment_centavos, interest_centavos FROM public.loan_schedule_lines WHERE loan_id = ${loanId} ORDER BY seq LIMIT 1`;
    expect(lines[0]).toEqual({ seq: 1, payment_centavos: "2224445", interest_centavos: "1000000" });
    await expectDbError(
      sql`INSERT INTO public.loan_schedule_lines (loan_id, seq, due_date, opening_balance_centavos, principal_centavos, interest_centavos, payment_centavos, closing_balance_centavos)
          VALUES (${loanId}, 99, '2031-01-01', 100, 10, 5, 16, 90)`,
      /loan_line_math/,
    );
    await expectDbError(sql`UPDATE public.loan_schedule_lines SET payment_centavos = 1 WHERE loan_id = ${loanId}`, /append-only/);
  });

  it("payments apply oldest-first; overdue and upcoming dues are alerted; reversals correct mistakes", async () => {
    const { loanId } = await newLoan();
    const p = await withUserTx(as(finance), (tx) => recordLoanPayment(tx, { loanId, paidOn: D("2026-10-15"), amount: BigInt(2_224_445), reference: "BDO-1" }));
    let s = await withUserTx(as(finance), (tx) => getLoanStatus(tx, loanId, D("2026-11-20")));
    expect(s!.lines[0].status).toBe("paid");
    expect(s!.lines[1]).toMatchObject({ status: "unpaid", overdue: true });
    const alerts = await withUserTx(as(finance), (tx) => loanDueAlerts(tx, D("2026-11-20"), 30));
    expect(alerts.filter((a) => a.loan_id === loanId).map((a) => [a.due_date, a.overdue])).toEqual([
      ["2026-11-15", true],
      ["2026-12-15", false],
    ]);
    await withUserTx(as(finance), (tx) => reverseLoanPayment(tx, { paymentId: p, reason: "posted to wrong loan", today: D("2026-11-20") }));
    s = await withUserTx(as(finance), (tx) => getLoanStatus(tx, loanId, D("2026-11-20")));
    expect(s!.totalPaid).toBe(BigInt(0));
    await expect(withUserTx(as(finance), (tx) => reverseLoanPayment(tx, { paymentId: p, reason: "again", today: D("2026-11-20") }))).rejects.toThrow();
  });

  it("is hidden from operations and drivers", async () => {
    await newLoan();
    for (const u of [ops, driverUser]) {
      const rows = await withUserTx(as(u), (tx) => tx.execute(dsql`SELECT id FROM public.vehicle_loans`));
      expect(rows.length).toBe(0);
    }
  });
});


describe("per-vehicle profitability and finance alerts", () => {
  it("attributes collections to the vehicle and subtracts loan payments", async () => {
    const { vehicleProfitability } = await import("@/server/queries/profitability");
    const { d, v, account } = await setup({ start: "2027-03-01", firstDue: "2027-03-15", downPayment: 0, price: 60_000 });
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2027-03-20"), "test"));
    await pay(d, account, pesos(700), "2027-03-20"); // part of the 1,000 installment
    const loanId = await withUserTx(as(finance), (tx) =>
      createVehicleLoan(tx, { vehicleId: v, lender: "Dealer", principal: pesos(100_000), annualRateBps: 0, termMonths: 10, firstDueDate: D("2027-03-10") }),
    );
    await withUserTx(as(finance), (tx) => recordLoanPayment(tx, { loanId, paidOn: D("2027-03-10"), amount: pesos(10_000) }));
    const rows = await withUserTx(as(finance), (tx) => vehicleProfitability(tx, v, D("2027-03-31"), 2));
    expect(rows[0]).toEqual({ month: "2027-03", boundary_charged: "0", boundary_collected: "0", amortization_collected: "70000", loan_paid: "1000000", expenses: "0", investor_share: "0" });
    expect(rows).toHaveLength(2);
  });

  it("flags contracts at 3+ missed amortizations", async () => {
    const { financeAlerts } = await import("@/server/queries/alerts");
    const { contractId } = await setup({ start: "2027-05-01", firstDue: "2027-05-01", downPayment: 0 });
    await withSystemTx("test", (tx) => runDailyCharges(tx, D("2027-07-02"), "test"));
    const a = await withUserTx(as(finance), (tx) => financeAlerts(tx, D("2027-07-02")));
    expect(a.flagged.find((f) => f.contractId === contractId)?.missed).toBe(3);
  });
});

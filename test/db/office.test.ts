import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import { EMPTY_INPUTS } from "@/lib/payroll";
import { assignVehicle, startBoundaryPlan } from "@/server/money/fleet";
import { createRtoContract } from "@/server/money/rto";
import { approveReferral, createReferralCommission, payReferral, recordCommissionReceived, voidCommissionReceived } from "@/server/office/commissions";
import { budgetVsActual, payRecurring, recordExpense, recurringForMonth, setBudget, voidExpense } from "@/server/office/expenses";
import { generateInvestorPayouts, markInvestorPayoutPaid, setVehicleInvestor } from "@/server/office/investors";
import {
  breakdownOf,
  createPayrollPeriod,
  finalizePayroll,
  giveCashAdvance,
  liquidateCashAdvance,
  markPayrollPaid,
  outstandingAdvances,
  recordThirteenthMonth,
  thirteenthMonthReport,
  updatePayrollLine,
} from "@/server/office/payroll";
import { as, schema, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { employees, payrollLines, recurringExpenses, drivers, vehicles, investors } = schema;
const D = isoDate;
let finance: string, ops: string, staffUser: string, investorUser: string;
let employeeId: string, dailyEmployeeId: string;

async function category(name: string) {
  const [c] = await sql`SELECT id FROM public.expense_categories WHERE name = ${name}`;
  return c.id as string;
}

beforeAll(async () => {
  finance = await createUser("O Finance", ["finance"]);
  ops = await createUser("O Ops", ["operations"]);
  staffUser = await createUser("O Staff", ["operations"]);
  investorUser = await createUser("O Investor", ["investor"]);
  [employeeId, dailyEmployeeId] = await withUserTx(as(finance), async (tx) => {
    const [a] = await tx
      .insert(employees)
      .values({ employeeNo: "E-001", profileId: staffUser, firstName: "Ana", lastName: "Office", hireDate: "2026-01-05", basis: "monthly", rateCentavos: pesos(30_000) })
      .returning({ id: employees.id });
    const [b] = await tx
      .insert(employees)
      .values({ employeeNo: "E-002", firstName: "Ben", lastName: "Helper", hireDate: "2026-01-05", basis: "daily", rateCentavos: pesos(645), allowanceCentavos: pesos(500) })
      .returning({ id: employees.id });
    return [a.id, b.id];
  });
});
afterAll(async () => {
  await sql.end();
});

describe("expenses", () => {
  it("records, voids (never deletes) and totals against the budget", async () => {
    const rent = await category("Office rent");
    const id = await withUserTx(as(finance), async (tx) => {
      await setBudget(tx, rent, D("2027-02-01"), pesos(25_000));
      await recordExpense(tx, { categoryId: rent, description: "Feb rent", amount: pesos(25_000), expenseDate: D("2027-02-03") });
      return recordExpense(tx, { categoryId: rent, description: "Duplicate", amount: pesos(25_000), expenseDate: D("2027-02-03") });
    });
    await withUserTx(as(finance), (tx) => voidExpense(tx, id, "entered twice", finance));
    const rows = await withUserTx(as(finance), (tx) => budgetVsActual(tx, D("2027-02-01")));
    expect(rows.find((r) => r.category === "Office rent")).toMatchObject({ budget: "2500000", actual: "2500000" });
    await expectDbError(sql`UPDATE public.expenses SET amount_centavos = 1 WHERE id = ${id}`, /already void/);
    await expectDbError(sql`DELETE FROM public.expenses WHERE id = ${id}`, /append-only/);
  });

  it("recurring bills are due monthly and can only be recorded once per month", async () => {
    const net = await category("Internet");
    const rid = await withUserTx(as(finance), async (tx) => {
      const [r] = await tx.insert(recurringExpenses).values({ categoryId: net, vendor: "PLDT", amountCentavos: pesos(2_699), dueDay: 31, startMonth: "2027-01-01" }).returning({ id: recurringExpenses.id });
      return r.id;
    });
    const due = await withUserTx(as(finance), (tx) => recurringForMonth(tx, D("2027-02-01")));
    expect(due.find((d) => d.id === rid)).toMatchObject({ due_date: "2027-02-28", paid_expense_id: null });
    await withUserTx(as(finance), (tx) => payRecurring(tx, { recurringId: rid, month: D("2027-02-01"), paidOn: D("2027-02-25") }));
    await expect(withUserTx(as(finance), (tx) => payRecurring(tx, { recurringId: rid, month: D("2027-02-01"), paidOn: D("2027-02-26") }))).rejects.toThrow(/already recorded/);
  });

  it("operations and drivers can't see office expenses", async () => {
    const rows = await withUserTx(as(ops), (tx) => tx.execute(dsql`SELECT id FROM public.expenses`));
    expect(rows).toHaveLength(0);
  });
});

describe("payroll", () => {
  it("drafts a semi-monthly payroll, applies inputs, locks on finalize, books cost when paid", async () => {
    const ca = await withUserTx(as(finance), (tx) => giveCashAdvance(tx, { employeeId, givenOn: D("2027-03-01"), amount: pesos(3_000), purpose: "Client meeting" }));
    await withUserTx(as(finance), (tx) => liquidateCashAdvance(tx, { cashAdvanceId: ca, amount: pesos(1_800), settledOn: D("2027-03-03"), description: "Meals + Grab, receipts" }));
    const periodId = await withUserTx(as(finance), (tx) => createPayrollPeriod(tx, 2027, 3, 1));
    const lines = await sql`SELECT id, employee_id, cash_advance_deduction_centavos, net_pay_centavos FROM public.payroll_lines WHERE period_id = ${periodId}`;
    const ana = lines.find((l) => l.employee_id === employeeId)!;
    const ben = lines.find((l) => l.employee_id === dailyEmployeeId)!;
    // Unliquidated ₱1,200 given > 7 days before the cut-off end is proposed as a deduction.
    expect(ana.cash_advance_deduction_centavos).toBe("120000");
    expect(ana.net_pay_centavos).toBe(String(1327125 - 120000));

    await withUserTx(as(finance), (tx) => updatePayrollLine(tx, ben.id, { ...EMPTY_INPUTS, daysWorkedHundredths: 1300 }));
    const [benAfter] = await sql`SELECT gross_taxable_centavos FROM public.payroll_lines WHERE id = ${ben.id}`;
    expect(benAfter.gross_taxable_centavos).toBe(String(64500 * 13));

    await withUserTx(as(finance), (tx) => finalizePayroll(tx, periodId, finance));
    expect(await withUserTx(as(finance), (tx) => outstandingAdvances(tx, employeeId))).toEqual([]);
    await expectDbError(
      withUserTx(as(finance), (tx) => updatePayrollLine(tx, ben.id, EMPTY_INPUTS)),
      /already finalized/,
    );
    await expectDbError(sql`UPDATE public.payroll_lines SET net_pay_centavos = 1 WHERE id = ${ben.id}`, /finalized; post corrections/);
    await expectDbError(sql`UPDATE public.payroll_periods SET status = 'draft' WHERE id = ${periodId}`, /draft → finalized → paid/);

    await withUserTx(as(finance), (tx) => markPayrollPaid(tx, periodId, finance));
    const cost = await sql`SELECT amount_centavos FROM public.expenses WHERE reference = ${`payroll:${periodId}`}`;
    // Hand-computed: Ana 15,000 + ER (SSS 1,500 + EC 15 + PhilHealth 375 + Pag-IBIG 100) = 16,990.00
    // Ben 8,385 + 500 allowance + ER on ₱14,028.75/month (SSS MSC 14,000 → 700 + EC 5, PhilHealth 701.44 → 175.36, Pag-IBIG 100) = 9,865.36
    expect(cost).toEqual([{ amount_centavos: "2685536" }]);
    const [anaLine] = await sql`SELECT * FROM public.payroll_lines WHERE id = ${ana.id}`;
    expect(breakdownOf({ computed: anaLine.computed } as never).sssEmployer).toBe(pesos(1_500));
  });

  it("staff see only their own finalized payslip", async () => {
    const mine = await withUserTx(as(staffUser), (tx) => tx.select({ e: payrollLines.employeeId }).from(payrollLines));
    expect(mine.map((r) => r.e)).toEqual([employeeId]);
    const draftPeriod = await withUserTx(as(finance), (tx) => createPayrollPeriod(tx, 2027, 3, 2));
    const stillOne = await withUserTx(as(staffUser), (tx) => tx.select({ p: payrollLines.periodId }).from(payrollLines));
    expect(stillOne.map((r) => r.p)).not.toContain(draftPeriod);
    const others = await withUserTx(as(ops), (tx) => tx.execute(dsql`SELECT id FROM public.payroll_lines`));
    expect(others).toHaveLength(0);
  });

  it("13th month = basic earned in finalized payrolls ÷ 12, recorded once", async () => {
    const report = await withUserTx(as(finance), (tx) => thirteenthMonthReport(tx, 2027));
    const ana = report.find((r) => r.employeeId === employeeId)!;
    expect(ana.basicEarned).toBe(pesos(15_000));
    expect(ana.amount).toBe(pesos(1_250));
    await withUserTx(as(finance), (tx) => recordThirteenthMonth(tx, { employeeIds: [employeeId], year: 2027, paidOn: D("2027-12-15") }));
    const again = await withUserTx(as(finance), (tx) => recordThirteenthMonth(tx, { employeeIds: [employeeId], year: 2027, paidOn: D("2027-12-15") }));
    expect(again).toBe(0);
  });

  it("settlements can't exceed the cash advance", async () => {
    const ca = await withUserTx(as(finance), (tx) => giveCashAdvance(tx, { employeeId, givenOn: D("2027-04-01"), amount: pesos(1_000), purpose: "Meeting" }));
    await expect(
      withUserTx(as(finance), (tx) => liquidateCashAdvance(tx, { cashAdvanceId: ca, amount: pesos(1_500), settledOn: D("2027-04-02"), description: "too much" })),
    ).rejects.toThrow();
  });
});

describe("commissions", () => {
  it("referral = 10% of down payment, payable after a month, forward-only status", async () => {
    const { contractId } = await withUserTx(as(ops), async (tx) => {
      const [d] = await tx.insert(drivers).values({ firstName: "Ref", lastName: "Driver", phone: "09176660001", status: "active" }).returning({ id: drivers.id });
      const [v] = await tx.insert(vehicles).values({ plateNo: "REF 0001", make: "Toyota", model: "Vios" }).returning({ id: vehicles.id });
      return { d: d.id, v: v.id, contractId: "" };
    }).then(async (ids) => ({
      contractId: await withUserTx(as(finance), (tx) =>
        createRtoContract(tx, { driverId: ids.d, vehicleId: ids.v, contractPrice: pesos(700_000), downPayment: pesos(50_000), termMonths: 60, startDate: D("2027-05-10"), firstDueDate: D("2027-06-10") }, D("2027-05-10")),
      ),
    }));
    const id = await withUserTx(as(finance), (tx) => createReferralCommission(tx, { rtoContractId: contractId, referrerType: "external", referrerName: "Kuya Jun" }));
    const [r] = await sql`SELECT amount_centavos, payable_on::text p, status FROM public.referral_commissions WHERE id = ${id}`;
    expect(r).toEqual({ amount_centavos: "500000", p: "2027-06-10", status: "pending" });
    await expect(withUserTx(as(finance), (tx) => approveReferral(tx, id, finance, D("2027-06-09")))).rejects.toThrow(/Not yet payable/);
    await expect(withUserTx(as(finance), (tx) => payReferral(tx, id, D("2027-06-10"), "GCash"))).rejects.toThrow(/Approve/);
    await withUserTx(as(finance), (tx) => approveReferral(tx, id, finance, D("2027-06-10")));
    await withUserTx(as(finance), (tx) => payReferral(tx, id, D("2027-06-11"), "GCash 123"));
    await expectDbError(sql`UPDATE public.referral_commissions SET status = 'pending' WHERE id = ${id}`, /cannot go from paid/);
    await expectDbError(sql`UPDATE public.referral_commissions SET amount_centavos = 1 WHERE id = ${id}`, /cannot change/);
  });

  it("commissions received are recorded and voided, never edited", async () => {
    const id = await withUserTx(as(finance), (tx) =>
      recordCommissionReceived(tx, { sourceType: "platform", counterparty: "inDrive", description: "Activation incentive", amount: pesos(1_500), receivedOn: D("2027-05-01") }),
    );
    await withUserTx(as(finance), (tx) => voidCommissionReceived(tx, id, "wrong month", finance));
    await expect(withUserTx(as(finance), (tx) => voidCommissionReceived(tx, id, "again", finance))).rejects.toThrow(/already void/);
  });
});

describe("investor share", () => {
  it("22 × driver's daily boundary − driver's monthly RTO amortization; paid rows locked; investor sees own", async () => {
    const setup = await withUserTx(as(ops), async (tx) => {
      const [d] = await tx.insert(drivers).values({ firstName: "Inv", lastName: "Driver", phone: "09176660002", status: "active" }).returning({ id: drivers.id });
      const [v] = await tx.insert(vehicles).values({ plateNo: "INV 0001", make: "BYD", model: "e6", powertrain: "ev" }).returning({ id: vehicles.id });
      const [v2] = await tx.insert(vehicles).values({ plateNo: "INV 0002", make: "BYD", model: "e6" }).returning({ id: vehicles.id });
      await startBoundaryPlan(tx, { driverId: d.id, programType: "rto", dailyRate: pesos(700), effectiveFrom: D("2027-07-01") }, D("2027-07-01"));
      await assignVehicle(tx, { driverId: d.id, vehicleId: v.id, startDate: D("2027-07-01") });
      return { d: d.id, v: v.id, v2: v2.id };
    });
    await withUserTx(as(finance), (tx) =>
      createRtoContract(tx, { driverId: setup.d, vehicleId: setup.v, contractPrice: pesos(720_000), downPayment: BigInt(0), termMonths: 60, startDate: D("2027-07-01"), firstDueDate: D("2027-07-31") }, D("2027-07-01")),
    );
    const inv = await withUserTx(as(finance), async (tx) => {
      const [i] = await tx.insert(investors).values({ name: "Mr. Partner", profileId: investorUser }).returning({ id: investors.id });
      await setVehicleInvestor(tx, setup.v, i.id);
      await setVehicleInvestor(tx, setup.v2, i.id); // no driver → share 0
      return i.id;
    });
    const r = await withUserTx(as(finance), (tx) => generateInvestorPayouts(tx, D("2027-07-15")));
    expect(r.created).toBe(2);
    const rows = await sql`SELECT vehicle_id, daily_rate_centavos, monthly_amortization_centavos, computed_centavos, payable_centavos FROM public.investor_payouts WHERE investor_id = ${inv} ORDER BY computed_centavos DESC`;
    expect(rows[0]).toEqual({ vehicle_id: setup.v, daily_rate_centavos: "70000", monthly_amortization_centavos: "1200000", computed_centavos: "340000", payable_centavos: "340000" });
    expect(rows[1]).toMatchObject({ vehicle_id: setup.v2, payable_centavos: "0" });

    const [p] = await sql`SELECT id FROM public.investor_payouts WHERE vehicle_id = ${setup.v}`;
    await withUserTx(as(finance), (tx) => markInvestorPayoutPaid(tx, p.id, D("2027-08-05"), "BDO transfer"));
    await expectDbError(sql`UPDATE public.investor_payouts SET payable_centavos = 1 WHERE id = ${p.id}`, /already paid/);
    await withUserTx(as(finance), (tx) => generateInvestorPayouts(tx, D("2027-07-15"))); // regeneration skips paid rows
    const [still] = await sql`SELECT status, payable_centavos FROM public.investor_payouts WHERE id = ${p.id}`;
    expect(still).toEqual({ status: "paid", payable_centavos: "340000" });

    const seen = await withUserTx(as(investorUser), async (tx) => ({
      payouts: await tx.execute(dsql`SELECT investor_id FROM public.investor_payouts`),
      vehicles: await tx.execute(dsql`SELECT plate_no FROM public.vehicles ORDER BY plate_no`),
      expenses: await tx.execute(dsql`SELECT id FROM public.expenses`),
    }));
    expect(seen.payouts.every((x) => x.investor_id === inv)).toBe(true);
    expect(seen.vehicles.map((v) => v.plate_no)).toEqual(["INV 0001", "INV 0002"]);
    expect(seen.expenses).toHaveLength(0);
  });
});


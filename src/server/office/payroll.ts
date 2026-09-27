import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  cashAdvances,
  cashAdvanceSettlements,
  employees,
  expenseCategories,
  payrollLines,
  payrollPeriods,
  thirteenthMonthPayouts,
} from "@/db/schema";
import { jsonb } from "@/db/sql";
import { addDays, type IsoDate } from "@/lib/dates";
import { sum, ZERO, type Centavos } from "@/lib/money";
import { computePayrollLine, payrollPeriod, thirteenthMonth, type PayrollInputs, type PayrollLine } from "@/lib/payroll";
import { MoneyRuleError } from "../money/errors";
import { recordExpense } from "./expenses";
import { getSetting, loadPayrollConfig } from "./settings";

type LineRow = typeof payrollLines.$inferSelect;
type Period = typeof payrollPeriods.$inferSelect;

export function inputsOf(l: LineRow): PayrollInputs {
  return {
    daysWorkedHundredths: l.daysWorkedHundredths,
    daysAbsentHundredths: l.daysAbsentHundredths,
    minutesLate: l.minutesLate,
    overtimeMinutes: l.overtimeMinutes,
    restOrSpecialMinutes: l.restSpecialMinutes,
    regularHolidayMinutes: l.regularHolidayMinutes,
    unworkedRegularHolidays: l.unworkedRegularHolidays,
    nightDiffMinutes: l.nightDiffMinutes,
    otherTaxableEarnings: l.otherTaxableEarningsCentavos,
    nonTaxableReimbursements: l.reimbursementsCentavos,
    otherDeductions: l.otherDeductionsCentavos,
    cashAdvanceDeduction: l.cashAdvanceDeductionCentavos,
  };
}

function inputColumns(i: PayrollInputs) {
  return {
    daysWorkedHundredths: i.daysWorkedHundredths,
    daysAbsentHundredths: i.daysAbsentHundredths,
    minutesLate: i.minutesLate,
    overtimeMinutes: i.overtimeMinutes,
    restSpecialMinutes: i.restOrSpecialMinutes,
    regularHolidayMinutes: i.regularHolidayMinutes,
    unworkedRegularHolidays: i.unworkedRegularHolidays,
    nightDiffMinutes: i.nightDiffMinutes,
    otherTaxableEarningsCentavos: i.otherTaxableEarnings,
    reimbursementsCentavos: i.nonTaxableReimbursements,
    otherDeductionsCentavos: i.otherDeductions,
    cashAdvanceDeductionCentavos: i.cashAdvanceDeduction,
  };
}

function computedColumns(c: PayrollLine, govIds: Record<string, string>) {
  const snapshot: Record<string, unknown> = { govTableIds: govIds, warnings: c.warnings };
  for (const [k, v] of Object.entries(c)) if (typeof v === "bigint") snapshot[k] = v.toString();
  return {
    grossTaxableCentavos: c.grossTaxable,
    withholdingTaxCentavos: c.withholdingTax,
    basicEarnedCentavos: c.basicEarned,
    netPayCentavos: c.netPay,
    computed: jsonb(snapshot),
  };
}

/** Reads a stored breakdown back into bigints (for payslips, registers). */
export function breakdownOf(l: LineRow): Record<string, bigint> & { warnings: string[] } {
  const raw = l.computed as Record<string, unknown>;
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && /^-?\d+$/.test(v)) out[k] = BigInt(v);
  return Object.assign(out, { warnings: (raw.warnings as string[]) ?? [] });
}

/** Unsettled amount per cash advance for an employee, oldest first. */
export async function outstandingAdvances(tx: Tx, employeeId: string) {
  const rows = await tx.execute<{ id: string; given_on: string; purpose: string; amount: string; settled: string }>(sql`
    SELECT ca.id, ca.given_on::text, ca.purpose, ca.amount_centavos::text AS amount,
      COALESCE((SELECT SUM(s.amount_centavos) FROM public.cash_advance_settlements s WHERE s.cash_advance_id = ca.id), 0)::text AS settled
    FROM public.cash_advances ca
    WHERE ca.employee_id = ${employeeId}::uuid AND ca.voided_at IS NULL
    ORDER BY ca.given_on, ca.created_at`);
  return rows
    .map((r) => ({ id: r.id, givenOn: r.given_on as IsoDate, purpose: r.purpose, amount: BigInt(r.amount), remaining: BigInt(r.amount) - BigInt(r.settled) }))
    .filter((r) => r.remaining > ZERO);
}

/** Owner rule: cash advances still unliquidated after N days are deducted from salary. */
export async function proposedCashAdvanceDeduction(tx: Tx, employeeId: string, periodEnd: IsoDate): Promise<Centavos> {
  const days = await getSetting(tx, "payroll.ca_deduct_after_days");
  const cutoff = addDays(periodEnd, -days);
  return sum((await outstandingAdvances(tx, employeeId)).filter((a) => a.givenOn <= cutoff).map((a) => a.remaining));
}

async function computeFor(tx: Tx, period: Period, emp: { basis: "monthly" | "daily"; rate: Centavos; allowance: Centavos; allowanceTaxable: boolean }, inputs: PayrollInputs) {
  const cfg = await loadPayrollConfig(tx, period.periodEnd);
  const c = computePayrollLine(emp, inputs, period.half as 1 | 2, cfg.settings, cfg.gov);
  return computedColumns(c, cfg.govIds);
}

/** Creates a semi-monthly draft with a line for every employee active during the period. */
export async function createPayrollPeriod(tx: Tx, year: number, month: number, half: 1 | 2): Promise<string> {
  const { start, end } = payrollPeriod(year, month, half);
  const delay = await getSetting(tx, "payroll.pay_delay_days");
  const [period] = await tx
    .insert(payrollPeriods)
    .values({ periodStart: start, periodEnd: end, half, payDate: addDays(end as IsoDate, delay) })
    .returning();
  const staff = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.status, "active"), lte(employees.hireDate, end), or(isNull(employees.separationDate), sql`${employees.separationDate} >= ${start}::date`)))
    .orderBy(asc(employees.lastName));
  for (const e of staff) {
    const inputs: PayrollInputs = {
      daysWorkedHundredths: 0,
      daysAbsentHundredths: 0,
      minutesLate: 0,
      overtimeMinutes: 0,
      restOrSpecialMinutes: 0,
      regularHolidayMinutes: 0,
      unworkedRegularHolidays: 0,
      nightDiffMinutes: 0,
      otherTaxableEarnings: ZERO,
      nonTaxableReimbursements: ZERO,
      otherDeductions: ZERO,
      cashAdvanceDeduction: await proposedCashAdvanceDeduction(tx, e.id, end as IsoDate),
    };
    const snap = { basis: e.basis, rate: e.rateCentavos, allowance: e.allowanceCentavos, allowanceTaxable: e.allowanceTaxable };
    await tx.insert(payrollLines).values({
      periodId: period.id,
      employeeId: e.id,
      basis: e.basis,
      rateCentavos: e.rateCentavos,
      allowanceCentavos: e.allowanceCentavos,
      allowanceTaxable: e.allowanceTaxable,
      ...inputColumns(inputs),
      ...(await computeFor(tx, period, snap, inputs)),
    });
  }
  return period.id;
}

async function getPeriod(tx: Tx, id: string): Promise<Period> {
  const [p] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, id));
  if (!p) throw new MoneyRuleError("Payroll period not found.");
  return p;
}

/** Saves one line's inputs and recomputes it (draft only; the DB also enforces this). */
export async function updatePayrollLine(tx: Tx, lineId: string, inputs: PayrollInputs, notes?: string): Promise<void> {
  const [line] = await tx.select().from(payrollLines).where(eq(payrollLines.id, lineId));
  if (!line) throw new MoneyRuleError("Payroll line not found.");
  const period = await getPeriod(tx, line.periodId);
  if (period.status !== "draft") throw new MoneyRuleError("This payroll is already finalized.");
  const snap = { basis: line.basis, rate: line.rateCentavos, allowance: line.allowanceCentavos, allowanceTaxable: line.allowanceTaxable };
  await tx
    .update(payrollLines)
    .set({ ...inputColumns(inputs), ...(await computeFor(tx, period, snap, inputs)), ...(notes !== undefined ? { notes } : {}) })
    .where(eq(payrollLines.id, lineId));
}

/** Refreshes rates from the employee records and recomputes every line (draft only). */
export async function recomputePayrollPeriod(tx: Tx, periodId: string): Promise<void> {
  const period = await getPeriod(tx, periodId);
  if (period.status !== "draft") throw new MoneyRuleError("This payroll is already finalized.");
  const lines = await tx
    .select({ l: payrollLines, e: employees })
    .from(payrollLines)
    .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
    .where(eq(payrollLines.periodId, periodId));
  for (const { l, e } of lines) {
    const snap = { basis: e.basis, rate: e.rateCentavos, allowance: e.allowanceCentavos, allowanceTaxable: e.allowanceTaxable };
    await tx
      .update(payrollLines)
      .set({ basis: e.basis, rateCentavos: e.rateCentavos, allowanceCentavos: e.allowanceCentavos, allowanceTaxable: e.allowanceTaxable, ...(await computeFor(tx, period, snap, inputsOf(l))) })
      .where(eq(payrollLines.id, l.id));
  }
}

/**
 * Locks the payroll. Salary deductions for cash advances are applied to the
 * employee's oldest unsettled advances. Negative net pay blocks finalizing.
 */
export async function finalizePayroll(tx: Tx, periodId: string, userId: string): Promise<void> {
  await recomputePayrollPeriod(tx, periodId);
  const lines = await tx.select().from(payrollLines).where(eq(payrollLines.periodId, periodId));
  const negative = lines.filter((l) => l.netPayCentavos < ZERO);
  if (negative.length) throw new MoneyRuleError(`${negative.length} employee(s) have negative net pay. Reduce their deductions first.`);
  const period = await getPeriod(tx, periodId);
  for (const l of lines) {
    if (l.cashAdvanceDeductionCentavos <= ZERO) continue;
    const outstanding = await outstandingAdvances(tx, l.employeeId);
    if (sum(outstanding.map((a) => a.remaining)) < l.cashAdvanceDeductionCentavos) {
      throw new MoneyRuleError("A cash advance deduction is larger than the employee's unsettled advances.");
    }
  }
  await tx.update(payrollPeriods).set({ status: "finalized", finalizedAt: new Date(), finalizedBy: userId }).where(eq(payrollPeriods.id, periodId));
  for (const l of lines) {
    let left = l.cashAdvanceDeductionCentavos;
    for (const a of await outstandingAdvances(tx, l.employeeId)) {
      if (left <= ZERO) break;
      const take = left < a.remaining ? left : a.remaining;
      await tx.insert(cashAdvanceSettlements).values({
        cashAdvanceId: a.id,
        kind: "payroll_deduction",
        amountCentavos: take,
        settledOn: period.payDate,
        payrollLineId: l.id,
        notes: `Salary deduction ${period.periodStart} – ${period.periodEnd}`,
      });
      left -= take;
    }
  }
}

async function categoryId(tx: Tx, name: string): Promise<string> {
  const [c] = await tx.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.name, name));
  if (!c) throw new MoneyRuleError(`Expense category "${name}" is missing.`);
  return c.id;
}

/**
 * Marks the payroll as paid and books its cost: salaries + employer contributions
 * (category "Salaries") and staff reimbursements (category "Travel & meetings").
 */
export async function markPayrollPaid(tx: Tx, periodId: string, userId: string): Promise<void> {
  const period = await getPeriod(tx, periodId);
  if (period.status !== "finalized") throw new MoneyRuleError("Finalize the payroll before marking it paid.");
  const lines = await tx.select().from(payrollLines).where(eq(payrollLines.periodId, periodId));
  let cost = ZERO;
  let reimbursements = ZERO;
  for (const l of lines) {
    const b = breakdownOf(l);
    reimbursements += l.reimbursementsCentavos;
    cost += b.grossTaxable + (b.nonTaxable - l.reimbursementsCentavos) + b.sssEmployer + b.sssEc + b.philhealthEmployer + b.pagibigEmployer;
  }
  await tx.update(payrollPeriods).set({ status: "paid", paidAt: new Date(), paidBy: userId }).where(eq(payrollPeriods.id, periodId));
  const label = `Payroll ${period.periodStart} – ${period.periodEnd}`;
  if (cost > ZERO) {
    await recordExpense(tx, { categoryId: await categoryId(tx, "Salaries"), description: `${label}: salaries and employer contributions`, amount: cost, expenseDate: period.payDate as IsoDate, paidVia: "payroll", reference: `payroll:${period.id}` });
  }
  if (reimbursements > ZERO) {
    await recordExpense(tx, { categoryId: await categoryId(tx, "Travel & meetings"), description: `${label}: staff reimbursements`, amount: reimbursements, expenseDate: period.payDate as IsoDate, paidVia: "payroll", reference: `payroll:${period.id}` });
  }
}

// ---------------------------------------------------------------------------
// Cash advances
// ---------------------------------------------------------------------------
export async function giveCashAdvance(tx: Tx, input: { employeeId: string; givenOn: IsoDate; amount: Centavos; purpose: string }): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (!input.purpose.trim()) throw new MoneyRuleError("State the purpose (e.g. client meeting in Makati).");
  const [row] = await tx.insert(cashAdvances).values({ ...input, amountCentavos: input.amount, purpose: input.purpose.trim() }).returning({ id: cashAdvances.id });
  return row.id;
}

/** Receipts turned in against an advance: records the spending as an expense and settles the advance. */
export async function liquidateCashAdvance(
  tx: Tx,
  input: { cashAdvanceId: string; amount: Centavos; settledOn: IsoDate; description: string; categoryId?: string; vehicleId?: string | null },
): Promise<void> {
  const [ca] = await tx.select().from(cashAdvances).where(eq(cashAdvances.id, input.cashAdvanceId));
  if (!ca || ca.voidedAt) throw new MoneyRuleError("Cash advance not found.");
  const expenseId = await recordExpense(tx, {
    categoryId: input.categoryId ?? (await categoryId(tx, "Travel & meetings")),
    description: input.description,
    amount: input.amount,
    expenseDate: input.settledOn,
    paidVia: "cash_advance",
    employeeId: ca.employeeId,
    vehicleId: input.vehicleId ?? null,
  });
  await tx.insert(cashAdvanceSettlements).values({ cashAdvanceId: ca.id, kind: "liquidation", amountCentavos: input.amount, settledOn: input.settledOn, expenseId, notes: input.description });
}

export async function returnCashAdvance(tx: Tx, input: { cashAdvanceId: string; amount: Centavos; settledOn: IsoDate; notes?: string }): Promise<void> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  await tx.insert(cashAdvanceSettlements).values({ cashAdvanceId: input.cashAdvanceId, kind: "cash_return", amountCentavos: input.amount, settledOn: input.settledOn, notes: input.notes ?? "Cash returned" });
}

// ---------------------------------------------------------------------------
// 13th month
// ---------------------------------------------------------------------------
export type ThirteenthRow = { employeeId: string; name: string; basicEarned: Centavos; amount: Centavos; paid: { amount: Centavos; paidOn: string } | null };

/** 13th month per employee = basic salary earned in finalized/paid payrolls of the year ÷ 12. */
export async function thirteenthMonthReport(tx: Tx, year: number): Promise<ThirteenthRow[]> {
  const rows = await tx.execute<{ id: string; name: string; basic: string }>(sql`
    SELECT e.id, e.last_name || ', ' || e.first_name AS name,
      COALESCE((SELECT SUM(l.basic_earned_centavos) FROM public.payroll_lines l
        JOIN public.payroll_periods p ON p.id = l.period_id
        WHERE l.employee_id = e.id AND p.status IN ('finalized', 'paid')
          AND p.period_start >= ${`${year}-01-01`}::date AND p.period_end <= ${`${year}-12-31`}::date), 0)::text AS basic
    FROM public.employees e ORDER BY e.last_name, e.first_name`);
  const paid = await tx.select().from(thirteenthMonthPayouts).where(eq(thirteenthMonthPayouts.year, year));
  return rows.map((r) => {
    const p = paid.find((x) => x.employeeId === r.id);
    return {
      employeeId: r.id,
      name: r.name,
      basicEarned: BigInt(r.basic),
      amount: thirteenthMonth(BigInt(r.basic)),
      paid: p ? { amount: p.amountCentavos, paidOn: p.paidOn } : null,
    };
  });
}

export async function recordThirteenthMonth(tx: Tx, input: { employeeIds: string[]; year: number; paidOn: IsoDate }): Promise<number> {
  const report = await thirteenthMonthReport(tx, input.year);
  let n = 0;
  for (const r of report.filter((x) => input.employeeIds.includes(x.employeeId) && !x.paid && x.amount > ZERO)) {
    await tx.insert(thirteenthMonthPayouts).values({ employeeId: r.employeeId, year: input.year, basicEarnedCentavos: r.basicEarned, amountCentavos: r.amount, paidOn: input.paidOn });
    await recordExpense(tx, { categoryId: await categoryId(tx, "Salaries"), description: `13th month ${input.year}: ${r.name}`, amount: r.amount, expenseDate: input.paidOn, paidVia: "payroll", employeeId: r.employeeId });
    n++;
  }
  return n;
}


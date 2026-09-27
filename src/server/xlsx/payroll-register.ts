import "server-only";
import ExcelJS from "exceljs";
import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { employees, payrollLines, payrollPeriods } from "@/db/schema";
import { toDecimalString } from "@/lib/money";
import { breakdownOf } from "@/server/office/payroll";

const COLUMNS: [string, string][] = [
  ["basicPay", "Basic pay"],
  ["absenceDeduction", "Absences"],
  ["lateDeduction", "Lates"],
  ["holidayPay", "Holiday pay"],
  ["overtimePay", "Overtime"],
  ["premiumPay", "Premiums"],
  ["nightDiffPay", "Night diff"],
  ["allowance", "Allowance"],
  ["otherTaxableEarnings", "Other earnings"],
  ["grossTaxable", "Gross taxable"],
  ["nonTaxable", "Non-taxable"],
  ["sssEmployee", "SSS EE"],
  ["philhealthEmployee", "PhilHealth EE"],
  ["pagibigEmployee", "Pag-IBIG EE"],
  ["withholdingTax", "Withholding tax"],
  ["cashAdvanceDeduction", "Cash advance"],
  ["otherDeductions", "Other deductions"],
  ["netPay", "Net pay"],
  ["sssEmployer", "SSS ER"],
  ["sssEc", "SSS EC"],
  ["philhealthEmployer", "PhilHealth ER"],
  ["pagibigEmployer", "Pag-IBIG ER"],
];

/** Excel needs numbers; converting exact centavos via the decimal string keeps every digit. */
export const excelPesos = (c: bigint): number => Number(toDecimalString(c));

/** Payroll register as an Excel file. Totals are summed in exact centavos, not by Excel. */
export async function payrollRegisterXlsx(tx: Tx, periodId: string): Promise<Buffer | null> {
  const [period] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, periodId));
  if (!period) return null;
  const rows = await tx
    .select({ l: payrollLines, e: employees })
    .from(payrollLines)
    .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
    .where(eq(payrollLines.periodId, periodId))
    .orderBy(asc(employees.lastName));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Payroll ${period.periodStart}`);
  ws.addRow([`Payroll register ${period.periodStart} to ${period.periodEnd} (pay date ${period.payDate}) – ${period.status.toUpperCase()}`]).font = { bold: true };
  ws.addRow(["Employee no.", "Name", ...COLUMNS.map(([, l]) => l)]).font = { bold: true };
  const totals = COLUMNS.map(() => BigInt(0));
  for (const { l, e } of rows) {
    const b = breakdownOf(l);
    COLUMNS.forEach(([k], i) => (totals[i] += b[k] ?? BigInt(0)));
    ws.addRow([e.employeeNo, `${e.lastName}, ${e.firstName}`, ...COLUMNS.map(([k]) => excelPesos(b[k] ?? BigInt(0)))]);
  }
  ws.addRow(["", "TOTAL", ...totals.map(excelPesos)]).font = { bold: true };
  ws.columns.forEach((c, i) => {
    c.width = i === 1 ? 28 : 14;
    if (i >= 2) c.numFmt = "#,##0.00";
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

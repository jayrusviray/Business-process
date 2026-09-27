"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { employees } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { parseDecimalUnits, type PayrollInputs } from "@/lib/payroll";
import { zIsoDate, zPeso, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { friendlyError, MoneyRuleError } from "@/server/money/errors";
import {
  createPayrollPeriod,
  finalizePayroll,
  giveCashAdvance,
  liquidateCashAdvance,
  markPayrollPaid,
  recomputePayrollPeriod,
  recordThirteenthMonth,
  returnCashAdvance,
  updatePayrollLine,
} from "@/server/office/payroll";

const FIN = ["owner_admin", "finance"] as const;

export async function createPeriodAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(FIN);
  const input = z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/, "Choose a month"), half: z.enum(["1", "2"]) })
    .safeParse(formObject(formData));
  if (!input.success) return { error: input.error.issues[0].message };
  let id: string;
  try {
    const [y, m] = input.data.month.split("-").map(Number);
    id = await withUserTx(session.claims, (tx) => createPayrollPeriod(tx, y, m, Number(input.data.half) as 1 | 2));
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/payroll/${id}`);
}

function num(obj: Record<string, string>, key: string, units: number): number {
  try {
    return parseDecimalUnits(obj[key] ?? "", units);
  } catch (e) {
    throw new MoneyRuleError(`${key}: ${(e as Error).message}`);
  }
}

export async function saveLineAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { lineId, periodId } = z.object({ lineId: z.guid(), periodId: z.guid() }).parse(obj);
    const money = z.object({
      otherTaxableEarnings: zPesoOrZero,
      reimbursements: zPesoOrZero,
      otherDeductions: zPesoOrZero,
      cashAdvanceDeduction: zPesoOrZero,
    }).parse({
      otherTaxableEarnings: obj.otherTaxableEarnings ?? "",
      reimbursements: obj.reimbursements ?? "",
      otherDeductions: obj.otherDeductions ?? "",
      cashAdvanceDeduction: obj.cashAdvanceDeduction ?? "",
    });
    const inputs: PayrollInputs = {
      daysWorkedHundredths: num(obj, "daysWorked", 100),
      daysAbsentHundredths: num(obj, "daysAbsent", 100),
      minutesLate: num(obj, "minutesLate", 1),
      overtimeMinutes: num(obj, "overtimeHours", 60),
      restOrSpecialMinutes: num(obj, "restSpecialHours", 60),
      regularHolidayMinutes: num(obj, "regularHolidayHours", 60),
      unworkedRegularHolidays: num(obj, "unworkedRegularHolidays", 1),
      nightDiffMinutes: num(obj, "nightDiffHours", 60),
      otherTaxableEarnings: money.otherTaxableEarnings,
      nonTaxableReimbursements: money.reimbursements,
      otherDeductions: money.otherDeductions,
      cashAdvanceDeduction: money.cashAdvanceDeduction,
    };
    await withUserTx(s.claims, (tx) => updatePayrollLine(tx, lineId, inputs, (obj.notes ?? "").slice(0, 500)));
    revalidatePath(`/app/payroll/${periodId}`);
    return "Saved.";
  });
}

export async function periodStepAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { periodId, step } = z.object({ periodId: z.guid(), step: z.enum(["recompute", "finalize", "paid"]) }).parse(obj);
    await withUserTx(s.claims, async (tx) => {
      if (step === "recompute") await recomputePayrollPeriod(tx, periodId);
      if (step === "finalize") await finalizePayroll(tx, periodId, s.userId);
      if (step === "paid") await markPayrollPaid(tx, periodId, s.userId);
    });
    revalidatePath(`/app/payroll/${periodId}`);
    return step === "recompute" ? "Recomputed with current rates and tables." : step === "finalize" ? "Payroll finalized and locked." : "Marked as paid; payroll cost recorded in Expenses.";
  });
}

const EmployeeInput = z.object({
  employeeNo: z.string().trim().min(1).max(20),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  position: z.string().trim().max(80).default(""),
  hireDate: zIsoDate,
  separationDate: z.union([z.literal(""), zIsoDate]).transform((v) => v || null),
  basis: z.enum(["monthly", "daily"]),
  rate: zPeso,
  allowance: zPesoOrZero,
  allowanceTaxable: z.string().optional().transform((v) => v === "on"),
  tin: z.string().trim().max(20).default(""),
  sssNo: z.string().trim().max(20).default(""),
  philhealthNo: z.string().trim().max(20).default(""),
  pagibigNo: z.string().trim().max(20).default(""),
  bankAccount: z.string().trim().max(60).default(""),
  status: z.enum(["active", "inactive"]).default("active"),
  profileId: z.union([z.literal(""), z.guid()]).optional().transform((v) => v || null),
});

export async function saveEmployeeAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { rate, allowance, ...rest } = EmployeeInput.parse(obj);
    const values = { ...rest, rateCentavos: rate, allowanceCentavos: allowance };
    await withUserTx(s.claims, async (tx) => {
      if (obj.id) await tx.update(employees).set(values).where(eq(employees.id, z.guid().parse(obj.id)));
      else await tx.insert(employees).values(values);
    });
    revalidatePath("/app/payroll");
    return "Employee saved. Draft payrolls use the new rate after you click Recompute.";
  });
}

export async function cashAdvanceAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const kind = z.enum(["give", "liquidate", "return"]).parse(obj.kind);
    const today = businessToday();
    await withUserTx(s.claims, async (tx) => {
      if (kind === "give") {
        const i = z.object({ employeeId: z.guid("Choose an employee"), amount: zPeso, purpose: z.string().trim().min(3), givenOn: zIsoDate }).parse(obj);
        await giveCashAdvance(tx, i);
      } else if (kind === "liquidate") {
        const i = z.object({ cashAdvanceId: z.guid(), amount: zPeso, description: z.string().trim().min(3, "Describe what the receipts are for") }).parse(obj);
        await liquidateCashAdvance(tx, { ...i, settledOn: today });
      } else {
        const i = z.object({ cashAdvanceId: z.guid(), amount: zPeso }).parse(obj);
        await returnCashAdvance(tx, { ...i, settledOn: today });
      }
    });
    revalidatePath("/app/payroll");
    return kind === "give" ? "Cash advance recorded." : kind === "liquidate" ? "Liquidation recorded as an expense." : "Returned cash recorded.";
  });
}

export async function thirteenthAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  const ids = formData.getAll("employeeId").filter((v): v is string => typeof v === "string");
  return guarded(FIN, async (s) => {
    const { year, paidOn } = z.object({ year: z.coerce.number().int().min(2000).max(2100), paidOn: zIsoDate }).parse(obj);
    const n = await withUserTx(s.claims, (tx) => recordThirteenthMonth(tx, { employeeIds: z.array(z.guid()).parse(ids), year, paidOn }));
    revalidatePath("/app/payroll");
    return `${n} 13th month payout(s) recorded.`;
  });
}

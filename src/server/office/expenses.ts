import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { budgets, expenses, recurringExpenses } from "@/db/schema";
import { endOfMonth, type IsoDate } from "@/lib/dates";
import { ZERO, type Centavos } from "@/lib/money";
import { MoneyRuleError } from "../money/errors";

export type NewExpense = {
  categoryId: string;
  vendor?: string;
  description: string;
  amount: Centavos;
  expenseDate: IsoDate;
  paidVia?: string;
  reference?: string;
  vehicleId?: string | null;
  employeeId?: string | null;
  receiptDocumentId?: string | null;
};

export async function recordExpense(tx: Tx, e: NewExpense): Promise<string> {
  if (e.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (!e.description.trim()) throw new MoneyRuleError("Describe the expense.");
  const [row] = await tx
    .insert(expenses)
    .values({
      categoryId: e.categoryId,
      vendor: e.vendor?.trim() ?? "",
      description: e.description.trim(),
      amountCentavos: e.amount,
      expenseDate: e.expenseDate,
      paidVia: e.paidVia ?? "cash",
      reference: e.reference?.trim() ?? "",
      vehicleId: e.vehicleId ?? null,
      employeeId: e.employeeId ?? null,
      receiptDocumentId: e.receiptDocumentId ?? null,
    })
    .returning({ id: expenses.id });
  return row.id;
}

export async function voidExpense(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
  if (!reason.trim()) throw new MoneyRuleError("A reason is required.");
  const res = await tx
    .update(expenses)
    .set({ voidedAt: new Date(), voidedBy: userId, voidReason: reason.trim() })
    .where(and(eq(expenses.id, id), isNull(expenses.voidedAt)))
    .returning({ id: expenses.id });
  if (res.length === 0) throw new MoneyRuleError("Expense not found or already void.");
}

/** Records this month's payment of a recurring bill. Idempotent per bill per month. */
export async function payRecurring(tx: Tx, input: { recurringId: string; month: IsoDate; paidOn: IsoDate; amount?: Centavos; reference?: string }): Promise<string> {
  const [r] = await tx.select().from(recurringExpenses).where(eq(recurringExpenses.id, input.recurringId));
  if (!r) throw new MoneyRuleError("Recurring bill not found.");
  const [existing] = await tx
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(eq(expenses.recurringId, r.id), eq(expenses.recurringMonth, input.month), isNull(expenses.voidedAt)));
  if (existing) throw new MoneyRuleError("This bill is already recorded for that month.");
  const [row] = await tx
    .insert(expenses)
    .values({
      categoryId: r.categoryId,
      vendor: r.vendor,
      description: r.description || r.vendor,
      amountCentavos: input.amount ?? r.amountCentavos,
      expenseDate: input.paidOn,
      reference: input.reference ?? "",
      recurringId: r.id,
      recurringMonth: input.month,
    })
    .returning({ id: expenses.id });
  return row.id;
}

export type RecurringDue = { id: string; vendor: string; description: string; category: string; amount: string; due_date: string; paid_expense_id: string | null };

/** Recurring bills for a month with their due date and whether they're recorded. */
export async function recurringForMonth(tx: Tx, month: IsoDate): Promise<RecurringDue[]> {
  const rows = await tx.execute<{ id: string; vendor: string; description: string; category: string; amount: string; due_day: number; paid_expense_id: string | null }>(sql`
    SELECT r.id, r.vendor, r.description, c.name AS category, r.amount_centavos::text AS amount, r.due_day,
      (SELECT e.id FROM public.expenses e WHERE e.recurring_id = r.id AND e.recurring_month = ${month}::date AND e.voided_at IS NULL) AS paid_expense_id
    FROM public.recurring_expenses r JOIN public.expense_categories c ON c.id = r.category_id
    WHERE r.active AND r.start_month <= ${month}::date AND (r.end_month IS NULL OR r.end_month >= ${month}::date)
    ORDER BY r.due_day, r.vendor`);
  const last = Number(endOfMonth(month).slice(8));
  return rows.map((r) => ({ ...r, due_date: `${month.slice(0, 8)}${String(Math.min(r.due_day, last)).padStart(2, "0")}` }));
}

export type BudgetRow = { category_id: string; category: string; budget: string | null; actual: string };

export async function budgetVsActual(tx: Tx, month: IsoDate): Promise<BudgetRow[]> {
  return tx.execute<BudgetRow>(sql`
    SELECT c.id AS category_id, c.name AS category, b.amount_centavos::text AS budget,
      COALESCE((SELECT SUM(e.amount_centavos) FROM public.expenses e
        WHERE e.category_id = c.id AND e.voided_at IS NULL
          AND e.expense_date BETWEEN ${month}::date AND ${endOfMonth(month)}::date), 0)::text AS actual
    FROM public.expense_categories c
    LEFT JOIN public.budgets b ON b.category_id = c.id AND b.month = ${month}::date
    WHERE c.active ORDER BY c.sort, c.name`);
}

export async function setBudget(tx: Tx, categoryId: string, month: IsoDate, amount: Centavos): Promise<void> {
  if (amount < ZERO) throw new MoneyRuleError("Budget cannot be negative.");
  await tx
    .insert(budgets)
    .values({ categoryId, month, amountCentavos: amount })
    .onConflictDoUpdate({ target: [budgets.categoryId, budgets.month], set: { amountCentavos: amount } });
}

export async function expensesForMonth(tx: Tx, month: IsoDate) {
  return tx
    .select()
    .from(expenses)
    .where(and(gte(expenses.expenseDate, month), lte(expenses.expenseDate, endOfMonth(month))));
}


import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { parseMonthParam } from "@/components/boundary-calendar";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { MonthNav } from "@/components/month-nav";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { expenseCategories, expenses, vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday, endOfMonth } from "@/lib/dates";
import { toDecimalString } from "@/lib/money";
import { budgetVsActual, recurringForMonth } from "@/server/office/expenses";
import { payRecurringAction, recordExpenseAction, saveRecurringAction, setBudgetAction, voidExpenseAction } from "./actions";

export const metadata = { title: "Expenses" };

export default async function ExpensesPage({ searchParams }: PageProps<"/app/expenses">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const sp = await searchParams;
  const today = businessToday();
  const month = parseMonthParam(sp.month, today);
  const data = await withUserTx(session.claims, async (tx) => ({
    categories: await tx.select().from(expenseCategories).where(eq(expenseCategories.active, true)).orderBy(asc(expenseCategories.sort)),
    vehicleRows: await tx.select({ id: vehicles.id, plate: vehicles.plateNo }).from(vehicles).orderBy(asc(vehicles.plateNo)),
    budget: await budgetVsActual(tx, month),
    recurring: await recurringForMonth(tx, month),
    list: await tx
      .select({ e: expenses, category: expenseCategories.name, plate: vehicles.plateNo })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(vehicles, eq(vehicles.id, expenses.vehicleId))
      .where(and(gte(expenses.expenseDate, month), lte(expenses.expenseDate, endOfMonth(month))))
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt)),
  }));
  const totalBudget = data.budget.reduce((s, r) => s + BigInt(r.budget ?? 0), BigInt(0));
  const totalActual = data.budget.reduce((s, r) => s + BigInt(r.actual), BigInt(0));
  const monthParam = (m: string) => `/app/expenses?month=${m}`;

  return (
    <>
      <PageHeader title="Expenses" description="Office operating expenses, recurring bills and budget vs actual." actions={<MonthNav month={month} href={monthParam} />} />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Record an expense</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={recordExpenseAction} className="grid gap-3 sm:grid-cols-2">
              <Field label="Category" htmlFor="categoryId">
                <Select id="categoryId" name="categoryId" required>
                  <option value="">Choose…</option>
                  {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Amount" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" required /></Field>
              <Field label="Description" htmlFor="description" className="sm:col-span-2"><Input id="description" name="description" required /></Field>
              <Field label="Vendor / payee" htmlFor="vendor"><Input id="vendor" name="vendor" /></Field>
              <Field label="Date" htmlFor="expenseDate"><Input id="expenseDate" name="expenseDate" type="date" defaultValue={today} required /></Field>
              <Field label="Paid via" htmlFor="paidVia">
                <Select id="paidVia" name="paidVia">
                  <option value="cash">Cash</option><option value="gcash">GCash</option><option value="maya">Maya</option>
                  <option value="bank_transfer">Bank transfer</option><option value="check">Check</option><option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Reference" htmlFor="reference"><Input id="reference" name="reference" /></Field>
              <Field label="Vehicle (optional)" htmlFor="vehicleId" hint="Counts in that vehicle's profitability.">
                <Select id="vehicleId" name="vehicleId">
                  <option value="">—</option>
                  {data.vehicleRows.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}
                </Select>
              </Field>
              <Field label="Receipt (optional)" htmlFor="receipt"><Input id="receipt" name="receipt" type="file" accept="image/*,application/pdf" /></Field>
              <Button type="submit" className="justify-self-start">Save expense</Button>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recurring bills this month</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {data.recurring.length === 0 ? <p className="text-sm text-muted-foreground">No recurring bills set up.</p> : null}
            {data.recurring.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm">
                <span>
                  <span className="font-medium">{r.vendor}</span> <span className="text-muted-foreground">· {r.category}</span>
                  <span className="block text-xs text-muted-foreground">due {r.due_date}</span>
                </span>
                {r.paid_expense_id ? (
                  <Badge variant="success">recorded</Badge>
                ) : (
                  <ActionForm action={payRecurringAction} inlineStatus className="flex items-center gap-2">
                    <input type="hidden" name="recurringId" value={r.id} />
                    <input type="hidden" name="month" value={month} />
                    <input type="hidden" name="paidOn" value={today} />
                    <Input name="amount" defaultValue={toDecimalString(BigInt(r.amount))} className="h-8 w-28" aria-label={`${r.vendor} amount`} />
                    <Badge variant={r.due_date < today ? "destructive" : "warning"}>{r.due_date < today ? "overdue" : "due"}</Badge>
                    <Button type="submit" size="sm" variant="outline">Record paid</Button>
                  </ActionForm>
                )}
              </div>
            ))}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer">Add a recurring bill</summary>
              <ActionForm action={saveRecurringAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Category" htmlFor="rcat">
                  <Select id="rcat" name="categoryId" required>
                    <option value="">Choose…</option>
                    {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Vendor" htmlFor="rvendor"><Input id="rvendor" name="vendor" required /></Field>
                <Field label="Amount" htmlFor="ramount"><Input id="ramount" name="amount" inputMode="decimal" required /></Field>
                <Field label="Due day of month" htmlFor="rdue"><Input id="rdue" name="dueDay" inputMode="numeric" defaultValue="15" required /></Field>
                <Field label="Starting" htmlFor="rstart"><Input id="rstart" name="startMonth" type="date" defaultValue={month} required /></Field>
                <Field label="Description" htmlFor="rdesc"><Input id="rdesc" name="description" /></Field>
                <Button type="submit" size="sm" className="justify-self-start">Save</Button>
              </ActionForm>
            </details>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader><CardTitle>Budget vs actual</CardTitle></CardHeader>
        <Table>
          <thead><tr><Th>Category</Th><Th className="w-56">Budget</Th><Th className="text-right">Actual</Th><Th className="text-right">Remaining</Th></tr></thead>
          <tbody>
            {data.budget.map((b) => {
              const remaining = b.budget === null ? null : BigInt(b.budget) - BigInt(b.actual);
              return (
                <tr key={b.category_id}>
                  <Td>{b.category}</Td>
                  <Td>
                    <ActionForm action={setBudgetAction} inlineStatus className="flex items-center gap-1">
                      <input type="hidden" name="categoryId" value={b.category_id} />
                      <input type="hidden" name="month" value={month} />
                      <Input name="amount" defaultValue={b.budget ? toDecimalString(BigInt(b.budget)) : ""} placeholder="no budget" className="h-8 w-32" aria-label={`${b.category} budget`} />
                      <Button type="submit" size="sm" variant="ghost">Save</Button>
                    </ActionForm>
                  </Td>
                  <Td className="text-right"><Money value={b.actual} /></Td>
                  <Td className="text-right">{remaining === null ? "—" : <Money value={remaining} className={remaining < BigInt(0) ? "text-destructive" : ""} />}</Td>
                </tr>
              );
            })}
            <tr className="font-medium"><Td>Total</Td><Td><Money value={totalBudget} /></Td><Td className="text-right"><Money value={totalActual} /></Td><Td className="text-right"><Money value={totalBudget - totalActual} /></Td></tr>
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader><CardTitle>Expenses in {month.slice(0, 7)}</CardTitle></CardHeader>
        <Table>
          <thead><tr><Th>Date</Th><Th>Category</Th><Th>Description</Th><Th className="text-right">Amount</Th><Th /></tr></thead>
          <tbody>
            {data.list.length === 0 ? <tr><Td colSpan={5} className="text-center text-muted-foreground">No expenses recorded.</Td></tr> : null}
            {data.list.map(({ e, category, plate }) => (
              <tr key={e.id} className={e.voidedAt ? "text-muted-foreground" : ""}>
                <Td className="whitespace-nowrap">{e.expenseDate}</Td>
                <Td>{category}{plate ? <div className="text-xs">{plate}</div> : null}</Td>
                <Td>
                  {e.description}
                  <div className="text-xs text-muted-foreground">
                    {e.vendor} {e.paidVia} {e.reference}
                    {e.receiptDocumentId ? <> · <Link className="underline" target="_blank" href={`/app/documents/${e.receiptDocumentId}`}>receipt</Link></> : null}
                  </div>
                </Td>
                <Td className="text-right"><Money value={e.amountCentavos} className={e.voidedAt ? "line-through" : ""} /></Td>
                <Td>
                  {e.voidedAt ? (
                    <Badge variant="muted">void: {e.voidReason}</Badge>
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">Void</summary>
                      <ActionForm action={voidExpenseAction} className="mt-1 flex gap-1">
                        <input type="hidden" name="id" value={e.id} />
                        <Input name="reason" placeholder="Reason" className="h-8" required />
                        <Button type="submit" size="sm" variant="destructive">Void</Button>
                      </ActionForm>
                    </details>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}


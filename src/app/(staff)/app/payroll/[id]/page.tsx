import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { employees, payrollLines, payrollPeriods } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { sum, toDecimalString } from "@/lib/money";
import { breakdownOf } from "@/server/office/payroll";
import { periodStepAction, saveLineAction } from "../actions";

export const metadata = { title: "Payroll period" };

const hrs = (minutes: number) => (minutes ? String(minutes / 60) : "");
const days = (hundredths: number) => (hundredths ? String(hundredths / 100) : "");
const peso = (c: bigint) => (c ? toDecimalString(c) : "");

export default async function PayrollPeriodPage({ params }: PageProps<"/app/payroll/[id]">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withUserTx(session.claims, async (tx) => {
    const [period] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, id));
    if (!period) return null;
    const lines = await tx
      .select({ l: payrollLines, e: employees })
      .from(payrollLines)
      .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
      .where(eq(payrollLines.periodId, id))
      .orderBy(asc(employees.lastName));
    return { period, lines };
  });
  if (!data) notFound();
  const { period, lines } = data;
  const draft = period.status === "draft";
  const b = lines.map(({ l }) => breakdownOf(l));
  const total = (k: string) => sum(b.map((x) => x[k] ?? BigInt(0)));
  const warnings = lines.flatMap(({ e }, i) => b[i].warnings.map((w) => `${e.lastName}: ${w}`));

  return (
    <>
      <PageHeader
        title={`Payroll ${period.periodStart} – ${period.periodEnd}`}
        description={`Pay date ${period.payDate} · ${lines.length} employee(s)`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={period.status === "paid" ? "success" : period.status === "finalized" ? "default" : "warning"}>{period.status}</Badge>
            <Button asChild variant="outline" size="sm"><a href={`/app/payroll/${period.id}/register`}>Register (Excel)</a></Button>
          </div>
        }
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Gross taxable", total("grossTaxable")],
          ["Withholding tax", total("withholdingTax")],
          ["Employee contributions", total("sssEmployee") + total("philhealthEmployee") + total("pagibigEmployee")],
          ["Employer contributions", total("sssEmployer") + total("sssEc") + total("philhealthEmployer") + total("pagibigEmployer")],
          ["Net pay", total("netPay")],
        ].map(([label, v]) => (
          <Card key={label as string}><CardHeader><CardDescription>{label as string}</CardDescription><CardTitle className="text-xl"><Money value={v as bigint} /></CardTitle></CardHeader></Card>
        ))}
      </div>
      {warnings.length ? (
        <Card className="mb-6 border-destructive/50"><CardContent className="pt-4 text-sm text-destructive">{warnings.map((w) => <div key={w}>{w}</div>)}</CardContent></Card>
      ) : null}
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-3 pt-4">
          {draft ? (
            <>
              <ActionForm action={periodStepAction} inlineStatus className="flex items-center gap-2">
                <input type="hidden" name="periodId" value={period.id} />
                <input type="hidden" name="step" value="recompute" />
                <Button type="submit" variant="outline">Recompute (latest rates &amp; tables)</Button>
              </ActionForm>
              <ActionForm action={periodStepAction} inlineStatus className="flex items-center gap-2">
                <input type="hidden" name="periodId" value={period.id} />
                <input type="hidden" name="step" value="finalize" />
                <Button type="submit">Finalize &amp; lock</Button>
              </ActionForm>
              <span className="text-xs text-muted-foreground">After finalizing, corrections go into the next payroll as other earnings/deductions.</span>
            </>
          ) : period.status === "finalized" ? (
            <ActionForm action={periodStepAction} inlineStatus className="flex items-center gap-2">
              <input type="hidden" name="periodId" value={period.id} />
              <input type="hidden" name="step" value="paid" />
              <Button type="submit">Mark as paid (books the cost in Expenses)</Button>
            </ActionForm>
          ) : (
            <span className="text-sm">Paid. <Link className="underline" href="/app/expenses">See Expenses</Link></span>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {lines.map(({ l, e }, i) => {
          const x = b[i];
          return (
            <Card key={l.id}>
              <CardHeader>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <CardTitle className="text-base">{e.lastName}, {e.firstName} <span className="text-sm font-normal text-muted-foreground">· {l.basis} · <Money value={l.rateCentavos} /></span></CardTitle>
                  <span className="flex items-center gap-3 text-sm">
                    Gross <Money value={x.grossTaxable} /> · Tax <Money value={x.withholdingTax} /> · Net <Money value={x.netPay} className="font-semibold" />
                    <a className="underline" href={`/app/payroll/payslip/${l.id}`} target="_blank">Payslip</a>
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <ActionForm action={saveLineAction} className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  <input type="hidden" name="lineId" value={l.id} />
                  <input type="hidden" name="periodId" value={period.id} />
                  {l.basis === "daily" ? (
                    <>
                      <Field label="Days worked" htmlFor={`dw-${l.id}`}><Input id={`dw-${l.id}`} name="daysWorked" inputMode="decimal" defaultValue={days(l.daysWorkedHundredths)} disabled={!draft} /></Field>
                      <Field label="Unworked reg. holidays" htmlFor={`urh-${l.id}`}><Input id={`urh-${l.id}`} name="unworkedRegularHolidays" inputMode="numeric" defaultValue={l.unworkedRegularHolidays || ""} disabled={!draft} /></Field>
                    </>
                  ) : (
                    <Field label="Days absent" htmlFor={`da-${l.id}`}><Input id={`da-${l.id}`} name="daysAbsent" inputMode="decimal" defaultValue={days(l.daysAbsentHundredths)} disabled={!draft} /></Field>
                  )}
                  <Field label="Minutes late" htmlFor={`ml-${l.id}`}><Input id={`ml-${l.id}`} name="minutesLate" inputMode="numeric" defaultValue={l.minutesLate || ""} disabled={!draft} /></Field>
                  <Field label="Overtime (hrs)" htmlFor={`ot-${l.id}`}><Input id={`ot-${l.id}`} name="overtimeHours" inputMode="decimal" defaultValue={hrs(l.overtimeMinutes)} disabled={!draft} /></Field>
                  <Field label="Rest/special day (hrs)" htmlFor={`rs-${l.id}`}><Input id={`rs-${l.id}`} name="restSpecialHours" inputMode="decimal" defaultValue={hrs(l.restSpecialMinutes)} disabled={!draft} /></Field>
                  <Field label="Regular holiday (hrs)" htmlFor={`rh-${l.id}`}><Input id={`rh-${l.id}`} name="regularHolidayHours" inputMode="decimal" defaultValue={hrs(l.regularHolidayMinutes)} disabled={!draft} /></Field>
                  <Field label="Night diff (hrs)" htmlFor={`nd-${l.id}`}><Input id={`nd-${l.id}`} name="nightDiffHours" inputMode="decimal" defaultValue={hrs(l.nightDiffMinutes)} disabled={!draft} /></Field>
                  <Field label="Other earnings" htmlFor={`oe-${l.id}`}><Input id={`oe-${l.id}`} name="otherTaxableEarnings" inputMode="decimal" defaultValue={peso(l.otherTaxableEarningsCentavos)} disabled={!draft} /></Field>
                  <Field label="Reimbursements" htmlFor={`re-${l.id}`}><Input id={`re-${l.id}`} name="reimbursements" inputMode="decimal" defaultValue={peso(l.reimbursementsCentavos)} disabled={!draft} /></Field>
                  <Field label="Cash advance ded." htmlFor={`ca-${l.id}`}><Input id={`ca-${l.id}`} name="cashAdvanceDeduction" inputMode="decimal" defaultValue={peso(l.cashAdvanceDeductionCentavos)} disabled={!draft} /></Field>
                  <Field label="Other deductions" htmlFor={`od-${l.id}`}><Input id={`od-${l.id}`} name="otherDeductions" inputMode="decimal" defaultValue={peso(l.otherDeductionsCentavos)} disabled={!draft} /></Field>
                  <Field label="Notes" htmlFor={`n-${l.id}`} className="col-span-2"><Input id={`n-${l.id}`} name="notes" defaultValue={l.notes} disabled={!draft} /></Field>
                  {draft ? <Button type="submit" variant="outline" className="self-end">Save &amp; recompute</Button> : null}
                </ActionForm>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Breakdown</summary>
                  <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3">
                    {[
                      ["Daily rate", x.dailyRate], ["Basic pay", x.basicPay], ["Absences", -x.absenceDeduction], ["Lates", -x.lateDeduction],
                      ["Holiday pay", x.holidayPay], ["Overtime", x.overtimePay], ["Premiums", x.premiumPay], ["Night diff", x.nightDiffPay],
                      ["Allowance", x.allowance], ["SSS (EE / ER)", x.sssEmployee], ["", x.sssEmployer], ["PhilHealth (EE / ER)", x.philhealthEmployee],
                      ["", x.philhealthEmployer], ["Pag-IBIG (EE / ER)", x.pagibigEmployee], ["", x.pagibigEmployer], ["Taxable income", x.taxableIncome],
                    ].map(([k, v], j) => (
                      <div key={j} className="flex justify-between gap-2"><dt className="text-muted-foreground">{k as string}</dt><dd><Money value={v as bigint} /></dd></div>
                    ))}
                  </dl>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

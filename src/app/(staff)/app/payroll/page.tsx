import { asc, desc, sql } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { employees, payrollPeriods } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { formatPeso, toDecimalString } from "@/lib/money";
import { cn } from "@/lib/utils";
import { outstandingAdvances, thirteenthMonthReport } from "@/server/office/payroll";
import { getSetting } from "@/server/office/settings";
import { cashAdvanceAction, createPeriodAction, saveEmployeeAction, thirteenthAction } from "./actions";

export const metadata = { title: "Payroll" };
const TABS = [["periods", "Payrolls"], ["employees", "Employees"], ["advances", "Cash advances"], ["thirteenth", "13th month"]] as const;
type Claims = Parameters<typeof withUserTx>[0];

export default async function PayrollPage({ searchParams }: PageProps<"/app/payroll">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const sp = await searchParams;
  const tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "periods") as (typeof TABS)[number][0];
  return (
    <>
      <PageHeader title="Payroll" description="Semi-monthly (1–15, 16–end). SSS, PhilHealth, Pag-IBIG split across both cut-offs; withholding tax per cut-off. Rates live in Settings." />
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b text-sm">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/app/payroll?tab=${k}`} className={cn("whitespace-nowrap border-b-2 px-3 py-2", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground")}>{l}</Link>
        ))}
      </nav>
      {tab === "periods" ? <Periods claims={session.claims} /> : null}
      {tab === "employees" ? <Employees claims={session.claims} /> : null}
      {tab === "advances" ? <Advances claims={session.claims} /> : null}
      {tab === "thirteenth" ? <Thirteenth claims={session.claims} year={Number(typeof sp.year === "string" ? sp.year : businessToday().slice(0, 4))} /> : null}
    </>
  );
}

async function Periods({ claims }: { claims: Claims }) {
  const rows = await withUserTx(claims, async (tx) => {
    const periods = await tx.select().from(payrollPeriods).orderBy(desc(payrollPeriods.periodStart)).limit(48);
    const totals = await tx.execute<{ period_id: string; n: number; net: string }>(sql`
      SELECT period_id, count(*)::int AS n, SUM(net_pay_centavos)::text AS net FROM public.payroll_lines GROUP BY period_id`);
    return periods.map((p) => ({ p, t: totals.find((t) => t.period_id === p.id) }));
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
      <Card className="self-start">
        <CardHeader><CardTitle>New payroll</CardTitle><CardDescription>Creates a draft with every active employee.</CardDescription></CardHeader>
        <CardContent>
          <ActionForm action={createPeriodAction} className="flex flex-wrap items-end gap-2">
            <Field label="Month" htmlFor="month"><Input id="month" name="month" type="month" defaultValue={businessToday().slice(0, 7)} required /></Field>
            <Field label="Cut-off" htmlFor="half">
              <Select id="half" name="half"><option value="1">1st–15th</option><option value="2">16th–end</option></Select>
            </Field>
            <Button type="submit">Create draft</Button>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <Table>
          <thead><tr><Th>Period</Th><Th>Pay date</Th><Th>Employees</Th><Th className="text-right">Net pay</Th><Th>Status</Th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><Td colSpan={5} className="text-muted-foreground">No payrolls yet.</Td></tr> : null}
            {rows.map(({ p, t }) => (
              <tr key={p.id}>
                <Td><Link className="font-medium underline-offset-2 hover:underline" href={`/app/payroll/${p.id}`}>{p.periodStart} – {p.periodEnd}</Link></Td>
                <Td>{p.payDate}</Td>
                <Td>{t?.n ?? 0}</Td>
                <Td className="text-right"><Money value={t?.net ?? "0"} /></Td>
                <Td><Badge variant={p.status === "paid" ? "success" : p.status === "finalized" ? "default" : "warning"}>{p.status}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function EmployeeForm({ e, logins }: { e?: typeof employees.$inferSelect; logins: { id: string; name: string }[] }) {
  const id = e?.id ?? "new";
  return (
    <ActionForm action={saveEmployeeAction} className="grid gap-2 sm:grid-cols-4">
      {e ? <input type="hidden" name="id" value={e.id} /> : null}
      <Field label="Employee no." htmlFor={`no-${id}`}><Input id={`no-${id}`} name="employeeNo" defaultValue={e?.employeeNo} required /></Field>
      <Field label="First name" htmlFor={`fn-${id}`}><Input id={`fn-${id}`} name="firstName" defaultValue={e?.firstName} required /></Field>
      <Field label="Last name" htmlFor={`ln-${id}`}><Input id={`ln-${id}`} name="lastName" defaultValue={e?.lastName} required /></Field>
      <Field label="Position" htmlFor={`pos-${id}`}><Input id={`pos-${id}`} name="position" defaultValue={e?.position} /></Field>
      <Field label="Salary basis" htmlFor={`basis-${id}`}>
        <Select id={`basis-${id}`} name="basis" defaultValue={e?.basis ?? "monthly"}><option value="monthly">Monthly</option><option value="daily">Daily</option></Select>
      </Field>
      <Field label="Monthly salary / daily rate" htmlFor={`rate-${id}`}><Input id={`rate-${id}`} name="rate" inputMode="decimal" defaultValue={e ? toDecimalString(e.rateCentavos) : ""} required /></Field>
      <Field label="Allowance per cut-off" htmlFor={`allow-${id}`}><Input id={`allow-${id}`} name="allowance" inputMode="decimal" defaultValue={e ? toDecimalString(e.allowanceCentavos) : "0"} /></Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="allowanceTaxable" defaultChecked={e?.allowanceTaxable} className="size-4" /> Allowance taxable</label>
      <Field label="Hired" htmlFor={`hire-${id}`}><Input id={`hire-${id}`} name="hireDate" type="date" defaultValue={e?.hireDate} required /></Field>
      <Field label="Separated" htmlFor={`sep-${id}`}><Input id={`sep-${id}`} name="separationDate" type="date" defaultValue={e?.separationDate ?? ""} /></Field>
      <Field label="TIN" htmlFor={`tin-${id}`}><Input id={`tin-${id}`} name="tin" defaultValue={e?.tin} /></Field>
      <Field label="SSS no." htmlFor={`sss-${id}`}><Input id={`sss-${id}`} name="sssNo" defaultValue={e?.sssNo} /></Field>
      <Field label="PhilHealth no." htmlFor={`ph-${id}`}><Input id={`ph-${id}`} name="philhealthNo" defaultValue={e?.philhealthNo} /></Field>
      <Field label="Pag-IBIG no." htmlFor={`hdmf-${id}`}><Input id={`hdmf-${id}`} name="pagibigNo" defaultValue={e?.pagibigNo} /></Field>
      <Field label="Bank account" htmlFor={`bank-${id}`}><Input id={`bank-${id}`} name="bankAccount" defaultValue={e?.bankAccount} /></Field>
      <Field label="Linked login (sees own payslips)" htmlFor={`login-${id}`}>
        <Select id={`login-${id}`} name="profileId" defaultValue={e?.profileId ?? ""}>
          <option value="">—</option>
          {logins.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      </Field>
      <Field label="Status" htmlFor={`st-${id}`}>
        <Select id={`st-${id}`} name="status" defaultValue={e?.status ?? "active"}><option value="active">Active</option><option value="inactive">Inactive</option></Select>
      </Field>
      <Button type="submit" className="justify-self-start">Save</Button>
    </ActionForm>
  );
}

async function Employees({ claims }: { claims: Claims }) {
  const { rows, logins } = await withUserTx(claims, async (tx) => ({
    rows: await tx.select().from(employees).orderBy(asc(employees.lastName)),
    logins: await tx.execute<{ id: string; name: string }>(sql`
      SELECT p.id, COALESCE(NULLIF(p.full_name, ''), p.email, p.phone) AS name FROM public.profiles p
      WHERE EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.id AND r.role IN ('owner_admin', 'finance', 'operations', 'sales'))
      ORDER BY 2`),
  }));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><CardTitle>Add employee</CardTitle></CardHeader>
        <CardContent><EmployeeForm logins={logins} /></CardContent>
      </Card>
      {rows.map((e) => (
        <Card key={e.id}>
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-4">
              <span className="font-medium">{e.lastName}, {e.firstName} <span className="text-sm font-normal text-muted-foreground">· {e.employeeNo} · {e.position}</span></span>
              <span className="flex items-center gap-2 text-sm">
                {formatPeso(e.rateCentavos)} / {e.basis === "monthly" ? "month" : "day"}
                <Badge variant={e.status === "active" ? "success" : "muted"}>{e.status}</Badge>
              </span>
            </summary>
            <CardContent><EmployeeForm e={e} logins={logins} /></CardContent>
          </details>
        </Card>
      ))}
    </div>
  );
}

async function Advances({ claims }: { claims: Claims }) {
  const { staff, open } = await withUserTx(claims, async (tx) => {
    const staff = await tx.select().from(employees).orderBy(asc(employees.lastName));
    const open = [];
    for (const e of staff) for (const a of await outstandingAdvances(tx, e.id)) open.push({ e, a });
    return { staff, open };
  });
  const today = businessToday();
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
      <Card className="self-start">
        <CardHeader><CardTitle>Give a cash advance</CardTitle><CardDescription>For business meetings/travel. Unliquidated amounts are proposed as salary deductions (see Settings).</CardDescription></CardHeader>
        <CardContent>
          <ActionForm action={cashAdvanceAction} className="grid gap-2">
            <input type="hidden" name="kind" value="give" />
            <Field label="Employee" htmlFor="caEmp">
              <Select id="caEmp" name="employeeId" required>
                <option value="">Choose…</option>
                {staff.filter((s) => s.status === "active").map((s) => <option key={s.id} value={s.id}>{s.lastName}, {s.firstName}</option>)}
              </Select>
            </Field>
            <Field label="Amount" htmlFor="caAmt"><Input id="caAmt" name="amount" inputMode="decimal" required /></Field>
            <Field label="Purpose" htmlFor="caPurpose"><Input id="caPurpose" name="purpose" required /></Field>
            <Field label="Date" htmlFor="caDate"><Input id="caDate" name="givenOn" type="date" defaultValue={today} required /></Field>
            <Button type="submit" className="justify-self-start">Record</Button>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Unsettled advances</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {open.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
          {open.map(({ e, a }) => (
            <div key={a.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{e.lastName}, {e.firstName} · {a.purpose}</span>
                <span>given {a.givenOn} · <Money value={a.amount} /> · remaining <Money value={a.remaining} className="font-medium" /></span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <ActionForm action={cashAdvanceAction} className="flex gap-1">
                  <input type="hidden" name="kind" value="liquidate" />
                  <input type="hidden" name="cashAdvanceId" value={a.id} />
                  <Input name="amount" placeholder="Receipts total" className="h-8 w-28" required aria-label="Liquidated amount" />
                  <Input name="description" placeholder="What for" className="h-8" required aria-label="Liquidation description" />
                  <Button type="submit" size="sm" variant="outline">Liquidate</Button>
                </ActionForm>
                <ActionForm action={cashAdvanceAction} className="flex gap-1">
                  <input type="hidden" name="kind" value="return" />
                  <input type="hidden" name="cashAdvanceId" value={a.id} />
                  <Input name="amount" placeholder="Cash returned" className="h-8 w-28" required aria-label="Returned amount" />
                  <Button type="submit" size="sm" variant="ghost">Returned</Button>
                </ActionForm>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

async function Thirteenth({ claims, year }: { claims: Claims; year: number }) {
  const [rows, exempt] = await withUserTx(claims, async (tx) => [
    await thirteenthMonthReport(tx, year),
    BigInt(await getSetting(tx, "payroll.thirteenth_month_tax_exempt_centavos")),
  ] as const);
  return (
    <Card>
      <CardHeader>
        <CardTitle>13th month pay {year}</CardTitle>
        <CardDescription>
          Total basic salary earned in finalized payrolls of {year} ÷ 12 (PD 851). Tax-exempt up to {formatPeso(exempt)} per year together with other benefits;
          amounts above that must be added to taxable pay; check with your accountant.
          <Link className="ml-2 underline" href={`/app/payroll?tab=thirteenth&year=${year - 1}`}>{year - 1}</Link>
        </CardDescription>
      </CardHeader>
      <ActionForm action={thirteenthAction} className="flex flex-col">
        <input type="hidden" name="year" value={year} />
        <Table>
          <thead><tr><Th /><Th>Employee</Th><Th className="text-right">Basic earned</Th><Th className="text-right">13th month</Th><Th>Status</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId}>
                <Td>{r.paid || r.amount === BigInt(0) ? null : <input type="checkbox" name="employeeId" value={r.employeeId} defaultChecked className="size-4" aria-label={r.name} />}</Td>
                <Td>{r.name}</Td>
                <Td className="text-right"><Money value={r.basicEarned} /></Td>
                <Td className="text-right"><Money value={r.amount} />{r.amount > exempt ? <Badge variant="warning" className="ml-1">above exemption</Badge> : null}</Td>
                <Td>{r.paid ? <Badge variant="success">paid {r.paid.paidOn}</Badge> : <Badge variant="muted">not paid</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="flex items-end gap-2 p-4">
          <Field label="Paid on" htmlFor="tmPaid"><Input id="tmPaid" name="paidOn" type="date" defaultValue={businessToday()} required /></Field>
          <Button type="submit">Record selected as paid</Button>
        </div>
      </ActionForm>
    </Card>
  );
}

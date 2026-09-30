import { sql } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Money } from "@/components/money";
import { withUserTx, type JwtClaims } from "@/db/client";
import { hasAnyRole, type Role } from "@/lib/auth/roles";
import { requireStaff } from "@/lib/auth/session";
import { addDays, businessToday, isIsoDate, type IsoDate } from "@/lib/dates";
import { periodRange, type PeriodKind } from "@/lib/metrics";
import { CURRENT_PHASE, navForRoles } from "@/lib/nav";
import { financeAlerts } from "@/server/queries/alerts";
import { driverAlerts } from "@/server/queries/driver-alerts";
import {
  ApplicationsSection,
  CollectionsTrendSection,
  CrmSection,
  DueListsSection,
  ExpiringPapersCard,
  FleetSection,
  FunnelSection,
  PayablesSection,
  PeriodSection,
  ProofsSection,
  RevenueTrendSection,
  SalesRevenueSection,
  TodaySection,
  VariancesSection,
} from "./_dashboard/sections";
import { Loading } from "./_dashboard/shared";

export const metadata = { title: "Dashboard" };

type View = "business" | "collections" | "sales";
const VIEW_LABEL: Record<View, string> = { business: "Business performance", collections: "Collections", sales: "Sales" };

/** Which dashboards a role may see (each section's data is also limited by RLS). */
function viewsFor(roles: readonly Role[]): View[] {
  const v: View[] = [];
  if (hasAnyRole(roles, ["owner_admin"])) v.push("business");
  if (hasAnyRole(roles, ["owner_admin", "finance", "operations"])) v.push("collections");
  if (hasAnyRole(roles, ["owner_admin", "sales", "documentation"])) v.push("sales");
  return v;
}

async function FinanceAlertCards({ claims, today }: { claims: JwtClaims; today: IsoDate }) {
  const alerts = await withUserTx(claims, (tx) => financeAlerts(tx, today));
  if (alerts.loans.length === 0 && alerts.flagged.length === 0) return null;
  return (
    <div className="mb-6 grid gap-3 lg:grid-cols-2">
      {alerts.flagged.length ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Drivers flagged: {alerts.flagAt}+ missed amortizations</CardTitle>
            <ul className="text-sm">
              {alerts.flagged.slice(0, 15).map((f) => (
                <li key={f.contractId} className="flex justify-between py-0.5">
                  <Link className="underline" href={`/app/rto/${f.contractId}`}>{f.driverName} · {f.contractNo}</Link>
                  <Badge variant="destructive">{f.missed} missed</Badge>
                </li>
              ))}
            </ul>
            {alerts.flagged.length > 15 ? <p className="text-xs text-muted-foreground">and {alerts.flagged.length - 15} more.</p> : null}
          </CardHeader>
        </Card>
      ) : null}
      {alerts.loans.length ? (
        <Card className="border-warning">
          <CardHeader>
            <CardTitle>Vehicle loan dues</CardTitle>
            <ul className="text-sm">
              {alerts.loans.slice(0, 15).map((a) => (
                <li key={a.loan_id + a.due_date} className="flex justify-between gap-2 py-0.5">
                  <Link className="underline" href={`/app/loans/${a.loan_id}`}>{a.plate_no} · {a.lender}</Link>
                  <span>
                    <Money value={a.amount_due} />{" "}
                    <Badge variant={a.overdue ? "destructive" : "warning"}>{a.overdue ? "overdue" : "due"} {a.due_date}</Badge>
                  </span>
                </li>
              ))}
            </ul>
            {alerts.loans.length > 15 ? <p className="text-xs text-muted-foreground">and {alerts.loans.length - 15} more.</p> : null}
          </CardHeader>
        </Card>
      ) : null}
    </div>
  );
}

async function DriverAlertCard({ claims, today }: { claims: JwtClaims; today: IsoDate }) {
  const drv = await withUserTx(claims, (tx) => driverAlerts(tx, today));
  if (drv.rows.length === 0) return null;
  return (
    <Card className="mb-6 border-warning">
      <CardHeader>
        <CardTitle>Drivers to follow up</CardTitle>
        <CardDescription>
          {drv.unpaidDaysAt}+ unpaid boundary days in a row
          {drv.balanceAt > BigInt(0) ? <>, balance of <Money value={drv.balanceAt} /> or more</> : null}, or a licence expiring within {drv.licenseDays} days.
        </CardDescription>
        <ul className="divide-y text-sm">
          {drv.rows.slice(0, 15).map((r) => (
            <li key={r.driver_id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <Link className="underline" href={`/app/drivers/${r.driver_id}`}>{r.name}</Link>
              <span className="flex flex-wrap items-center gap-1">
                {r.unpaid_days >= drv.unpaidDaysAt ? <Badge variant="destructive">{r.unpaid_days} days unpaid</Badge> : null}
                {drv.balanceAt > BigInt(0) && BigInt(r.balance) >= drv.balanceAt ? <Badge variant="warning">balance&nbsp;<Money value={r.balance} /></Badge> : null}
                {r.license_expiry && r.license_expiry <= addDays(today, drv.licenseDays) ? (
                  <Badge variant={r.license_expiry < today ? "destructive" : "warning"}>licence {r.license_expiry < today ? "expired" : "expires"} {r.license_expiry}</Badge>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {drv.rows.length > 15 ? <p className="text-xs text-muted-foreground">and {drv.rows.length - 15} more.</p> : null}
      </CardHeader>
    </Card>
  );
}

async function MyPayslips({ claims }: { claims: JwtClaims }) {
  const myPayslips = await withUserTx(claims, (tx) =>
    tx.execute<{ id: string; period_start: string; period_end: string; net: string }>(sql`
      SELECT l.id, p.period_start::text, p.period_end::text, l.net_pay_centavos::text AS net
      FROM public.payroll_lines l JOIN public.payroll_periods p ON p.id = l.period_id
      WHERE l.employee_id = app.current_employee_id() AND p.status <> 'draft'
      ORDER BY p.period_start DESC LIMIT 6`),
  );
  if (myPayslips.length === 0) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>My payslips</CardTitle>
        <ul className="text-sm">
          {myPayslips.map((p) => (
            <li key={p.id} className="flex justify-between py-0.5">
              <a className="underline" href={`/app/payroll/payslip/${p.id}`} target="_blank">{p.period_start} – {p.period_end}</a>
              <Money value={p.net} />
            </li>
          ))}
        </ul>
      </CardHeader>
    </Card>
  );
}

export default async function DashboardPage({ searchParams }: PageProps<"/app">) {
  const session = await requireStaff();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const today = businessToday();
  const views = viewsFor(session.roles);
  const view = (views.includes(one("view") as View) ? one("view") : views[0]) as View | undefined;
  const periodKind = (["day", "week", "month", "custom"].includes(one("period")) ? one("period") : "month") as PeriodKind;
  const { from, to } = periodRange(
    periodKind,
    today,
    isIsoDate(one("from")) ? (one("from") as IsoDate) : null,
    isIsoDate(one("to")) ? (one("to") as IsoDate) : null,
  );
  const p = { claims: session.claims, today };
  const r = { ...p, from, to };
  const canSeeLeads = hasAnyRole(session.roles, ["owner_admin", "operations", "sales"]);
  const canSeeMoney = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const modules = navForRoles(session.roles)
    .flatMap((s) => s.items)
    .filter((i) => i.href !== "/app");

  return (
    <>
      <PageHeader
        title={`Welcome${session.profile.fullName ? `, ${session.profile.fullName}` : ""}`}
        description={view ? `${VIEW_LABEL[view]} dashboard · ${today}` : undefined}
      />
      {canSeeMoney ? <Suspense fallback={null}><FinanceAlertCards {...p} /></Suspense> : null}
      {hasAnyRole(session.roles, ["owner_admin", "finance", "operations"]) ? <Suspense fallback={null}><DriverAlertCard {...p} /></Suspense> : null}
      {hasAnyRole(session.roles, ["owner_admin", "finance", "operations", "sales"]) ? (
        <div className="mb-6">
          <Suspense fallback={null}><ExpiringPapersCard {...p} /></Suspense>
        </div>
      ) : null}
      <Suspense fallback={null}><MyPayslips claims={session.claims} /></Suspense>

      {view ? (
        <section className="mb-8" aria-label={`${VIEW_LABEL[view]} dashboard`}>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            {views.length > 1 ? (
              <nav className="flex flex-wrap gap-1 rounded-md border p-1 text-sm" aria-label="Dashboards">
                {views.map((v) => (
                  <Link
                    key={v}
                    href={`/app?view=${v}`}
                    aria-current={v === view ? "page" : undefined}
                    className={v === view ? "rounded bg-muted px-3 py-1.5 font-medium" : "rounded px-3 py-1.5 hover:bg-muted/60"}
                  >
                    {VIEW_LABEL[v]}
                  </Link>
                ))}
              </nav>
            ) : (
              <span />
            )}
            {view !== "collections" ? (
              <form className="flex flex-wrap items-end gap-2 text-sm">
                <input type="hidden" name="view" value={view} />
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Period</span>
                  <Select name="period" defaultValue={periodKind} className="h-10 w-36">
                    <option value="day">Today</option>
                    <option value="week">This week</option>
                    <option value="month">This month</option>
                    <option value="custom">Custom dates</option>
                  </Select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">From (custom)</span>
                  <Input type="date" name="from" defaultValue={from} className="h-10 w-40" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">To (custom)</span>
                  <Input type="date" name="to" defaultValue={to} className="h-10 w-40" />
                </label>
                <Button type="submit" variant="outline">Show</Button>
              </form>
            ) : null}
          </div>

          {view === "business" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Suspense fallback={<Loading title="Today" />}><TodaySection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Period" />}><PeriodSection {...r} /></Suspense>
              <Suspense fallback={<Loading title="Daily collections" />}><CollectionsTrendSection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Revenue vs expenses" />}><RevenueTrendSection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Fleet and RTO" />}><FleetSection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Upcoming payables" />}><PayablesSection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Applications" />}><ApplicationsSection {...r} /></Suspense>
              <Suspense fallback={<Loading title="Leads" />}><CrmSection {...r} /></Suspense>
            </div>
          ) : null}
          {view === "collections" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Suspense fallback={<Loading title="Today" />}><TodaySection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Due today" />}><DueListsSection {...p} /></Suspense>
              {canSeeMoney ? <Suspense fallback={<Loading title="Payment proofs" />}><ProofsSection {...p} /></Suspense> : null}
              <Suspense fallback={<Loading title="Collector cash" />}><VariancesSection {...p} /></Suspense>
              <Suspense fallback={<Loading title="Daily collections" />}><CollectionsTrendSection {...p} /></Suspense>
            </div>
          ) : null}
          {view === "sales" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Suspense fallback={<Loading title="Revenue" />}><SalesRevenueSection {...r} appsOnly={!canSeeMoney} /></Suspense>
              {canSeeLeads ? <Suspense fallback={<Loading title="Lead funnel" />}><FunnelSection {...r} /></Suspense> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">Modules</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((m) => (
          <Link key={m.href} href={m.href} className="block">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{m.label}</CardTitle>
                  {m.phase > CURRENT_PHASE ? <Badge variant="muted">Phase {m.phase}</Badge> : <Badge variant="success">Ready</Badge>}
                </div>
                {m.description ? <CardDescription>{m.description}</CardDescription> : null}
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

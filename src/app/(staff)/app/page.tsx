import { sql } from "drizzle-orm";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/money";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireStaff } from "@/lib/auth/session";
import { addDays, businessToday } from "@/lib/dates";
import { financeAlerts } from "@/server/queries/alerts";
import { driverAlerts } from "@/server/queries/driver-alerts";
import { CURRENT_PHASE, navForRoles } from "@/lib/nav";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireStaff();
  const alerts = hasAnyRole(session.roles, ["owner_admin", "finance"])
    ? await withUserTx(session.claims, (tx) => financeAlerts(tx, businessToday()))
    : null;
  const drv = hasAnyRole(session.roles, ["owner_admin", "finance", "operations"])
    ? await withUserTx(session.claims, (tx) => driverAlerts(tx, businessToday()))
    : null;
  const myPayslips = await withUserTx(session.claims, (tx) =>
    tx.execute<{ id: string; period_start: string; period_end: string; net: string }>(sql`
      SELECT l.id, p.period_start::text, p.period_end::text, l.net_pay_centavos::text AS net
      FROM public.payroll_lines l JOIN public.payroll_periods p ON p.id = l.period_id
      WHERE l.employee_id = app.current_employee_id() AND p.status <> 'draft'
      ORDER BY p.period_start DESC LIMIT 6`),
  );
  const modules = navForRoles(session.roles)
    .flatMap((s) => s.items)
    .filter((i) => i.href !== "/app");
  return (
    <>
      <PageHeader
        title={`Welcome${session.profile.fullName ? `, ${session.profile.fullName}` : ""}`}
        description="The business performance dashboard (collections, aging, activations) arrives in Phase 8."
      />
      {alerts && (alerts.loans.length > 0 || alerts.flagged.length > 0) ? (
        <div className="mb-6 grid gap-3 lg:grid-cols-2">
          {alerts.flagged.length ? (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle>Drivers flagged: {alerts.flagAt}+ missed amortizations</CardTitle>
                <ul className="text-sm">
                  {alerts.flagged.map((f) => (
                    <li key={f.contractId} className="flex justify-between py-0.5">
                      <Link className="underline" href={`/app/rto/${f.contractId}`}>{f.driverName} · {f.contractNo}</Link>
                      <Badge variant="destructive">{f.missed} missed</Badge>
                    </li>
                  ))}
                </ul>
              </CardHeader>
            </Card>
          ) : null}
          {alerts.loans.length ? (
            <Card className="border-warning">
              <CardHeader>
                <CardTitle>Vehicle loan dues</CardTitle>
                <ul className="text-sm">
                  {alerts.loans.map((a) => (
                    <li key={a.loan_id + a.due_date} className="flex justify-between gap-2 py-0.5">
                      <Link className="underline" href={`/app/loans/${a.loan_id}`}>{a.plate_no} · {a.lender}</Link>
                      <span>
                        <Money value={a.amount_due} />{" "}
                        <Badge variant={a.overdue ? "destructive" : "warning"}>{a.overdue ? "overdue" : "due"} {a.due_date}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardHeader>
            </Card>
          ) : null}
        </div>
      ) : null}
      {drv && drv.rows.length ? (
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
                    {drv.balanceAt > BigInt(0) && BigInt(r.balance) >= drv.balanceAt ? <Badge variant="warning">balance <Money value={r.balance} /></Badge> : null}
                    {r.license_expiry && r.license_expiry <= addDays(businessToday(), drv.licenseDays) ? (
                      <Badge variant={r.license_expiry < businessToday() ? "destructive" : "warning"}>licence {r.license_expiry < businessToday() ? "expired" : "expires"} {r.license_expiry}</Badge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {drv.rows.length > 15 ? <p className="text-xs text-muted-foreground">and {drv.rows.length - 15} more.</p> : null}
          </CardHeader>
        </Card>
      ) : null}
      {myPayslips.length ? (
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
      ) : null}
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

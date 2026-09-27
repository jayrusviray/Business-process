import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { appSettings, vehicleLoans, vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday, formatBusinessDate, type IsoDate } from "@/lib/dates";
import { getLoanStatus, loanDueAlerts } from "@/server/money/loans";

export const metadata = { title: "Vehicle loans" };

export default async function LoansPage() {
  const session = await requireRole(["owner_admin", "finance"]);
  const today = businessToday();
  const { rows, alerts } = await withUserTx(session.claims, async (tx) => {
    const list = await tx
      .select({ l: vehicleLoans, plate: vehicles.plateNo })
      .from(vehicleLoans)
      .innerJoin(vehicles, eq(vehicles.id, vehicleLoans.vehicleId))
      .orderBy(desc(vehicleLoans.createdAt));
    const withStatus = [];
    for (const r of list) withStatus.push({ ...r, s: (await getLoanStatus(tx, r.l.id, today))! });
    const [days] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "loans.due_alert_days"));
    return { rows: withStatus, alerts: await loanDueAlerts(tx, today, typeof days?.value === "number" ? days.value : 7) };
  });
  return (
    <>
      <PageHeader
        title="Vehicle loans"
        description="Bank and dealer financing on a diminishing balance. Payments apply to the oldest installment first."
        actions={<Button asChild><Link href="/app/loans/new">New loan</Link></Button>}
      />
      {alerts.length ? (
        <Card className="mb-6 border-warning">
          <CardHeader>
            <CardTitle>Due soon or overdue</CardTitle>
            <ul className="text-sm">
              {alerts.map((a) => (
                <li key={a.loan_id + a.due_date} className="flex justify-between gap-2 py-0.5">
                  <Link href={`/app/loans/${a.loan_id}`} className="underline">{a.plate_no} · {a.lender}</Link>
                  <span>
                    <Money value={a.amount_due} /> {a.overdue ? <Badge variant="destructive">overdue since {a.due_date}</Badge> : <Badge variant="warning">due {formatBusinessDate(a.due_date as IsoDate)}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          </CardHeader>
        </Card>
      ) : null}
      <Card>
        <Table>
          <thead>
            <tr><Th>Vehicle</Th><Th>Lender</Th><Th className="text-right">Principal</Th><Th className="text-right">Monthly</Th><Th className="text-right">Balance</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? <tr><Td colSpan={6} className="text-center text-muted-foreground">No loans recorded.</Td></tr> : null}
            {rows.map(({ l, plate, s }) => (
              <tr key={l.id}>
                <Td><Link href={`/app/loans/${l.id}`} className="font-medium underline-offset-2 hover:underline">{plate}</Link></Td>
                <Td>{l.lender}<div className="text-xs text-muted-foreground">{(l.annualRateBps / 100).toFixed(2)}% · {l.termMonths} mo</div></Td>
                <Td className="text-right"><Money value={l.principalCentavos} /></Td>
                <Td className="text-right"><Money value={s.lines[0]?.payment ?? BigInt(0)} /></Td>
                <Td className="text-right"><Money value={s.balance} /></Td>
                <Td>{s.overdue > BigInt(0) ? <Badge variant="destructive">overdue <Money value={s.overdue} /></Badge> : <Badge variant={l.status === "active" ? "success" : "muted"}>{l.status.replace("_", " ")}</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

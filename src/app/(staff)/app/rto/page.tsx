import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { appSettings, drivers, rtoContracts, vehicles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { monthlyAmortization } from "@/lib/rto";
import { getRtoStatus, termsOf } from "@/server/money/rto";

export const metadata = { title: "RTO contracts" };

export default async function RtoListPage() {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const today = businessToday();
  const { rows, flagAt } = await withUserTx(session.claims, async (tx) => {
    const list = await tx
      .select({ c: rtoContracts, first: drivers.firstName, last: drivers.lastName, plate: vehicles.plateNo })
      .from(rtoContracts)
      .innerJoin(drivers, eq(drivers.id, rtoContracts.driverId))
      .innerJoin(vehicles, eq(vehicles.id, rtoContracts.vehicleId))
      .orderBy(desc(rtoContracts.createdAt));
    const [flag] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "collections.delinquency_missed_amortizations"));
    const withStatus = [];
    for (const r of list) withStatus.push({ ...r, s: (await getRtoStatus(tx, r.c.id, today))! });
    return { rows: withStatus, flagAt: typeof flag?.value === "number" ? flag.value : 3 };
  });

  return (
    <>
      <PageHeader
        title="RTO / boundary-hulog contracts"
        description="Monthly amortization = (price − down payment) ÷ term, no interest. Cashout = remaining principal."
        actions={
          hasAnyRole(session.roles, ["owner_admin", "finance"]) ? (
            <Button asChild>
              <Link href="/app/rto/new">New contract</Link>
            </Button>
          ) : undefined
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Contract</Th>
              <Th>Driver / vehicle</Th>
              <Th className="text-right">Monthly</Th>
              <Th className="w-48">Paid</Th>
              <Th className="text-right">Remaining</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={6} className="text-center text-muted-foreground">No contracts yet.</Td>
              </tr>
            ) : null}
            {rows.map(({ c, first, last, plate, s }) => (
              <tr key={c.id}>
                <Td>
                  <Link href={`/app/rto/${c.id}`} className="font-mono text-xs underline">{c.contractNo}</Link>
                  <div className="text-xs text-muted-foreground">since {c.startDate}</div>
                </Td>
                <Td>
                  <Link href={`/app/drivers/${c.driverId}`} className="underline-offset-2 hover:underline">{last}, {first}</Link>
                  <div className="text-xs text-muted-foreground">{plate}</div>
                </Td>
                <Td className="text-right"><Money value={monthlyAmortization(termsOf(c))} /></Td>
                <Td>
                  <ProgressBar percent={s.progress.percentPaid} label={`${c.contractNo} paid`} />
                  <div className="mt-1 text-xs text-muted-foreground">{s.progress.percentPaid.toFixed(1)}% · {s.progress.installmentsFullyPaid}/{c.termMonths}</div>
                </Td>
                <Td className="text-right"><Money value={s.progress.remaining} /></Td>
                <Td>
                  {c.status !== "active" ? (
                    <Badge variant="muted">{c.status.replace("_", " ")}</Badge>
                  ) : s.missed >= flagAt ? (
                    <Badge variant="destructive">{s.missed} missed: flagged</Badge>
                  ) : s.missed > 0 ? (
                    <Badge variant="warning">{s.missed} missed</Badge>
                  ) : (
                    <Badge variant="success">on track</Badge>
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

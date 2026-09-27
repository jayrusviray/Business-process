import { desc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { chargeRuns } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { runChargesNowAction } from "../actions";

export const metadata = { title: "Daily charges" };

const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

export default async function ChargeRunsPage() {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const runs = await withUserTx(session.claims, (tx) => tx.select().from(chargeRuns).orderBy(desc(chargeRuns.startedAt)).limit(60));
  return (
    <>
      <PageHeader
        title="Daily boundary charges"
        description="Posted automatically every day at 00:05 (Manila) for each active driver with a plan, except holidays. Missed days are caught up on the next run."
      />
      {hasAnyRole(session.roles, ["owner_admin", "finance"]) ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Run now</CardTitle>
            <CardDescription>Safe to run any time: a driver is never charged twice for the same day.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={runChargesNowAction} className="flex items-center gap-3">
              <Button type="submit">Post today&apos;s charges</Button>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Started</Th>
              <Th>Days</Th>
              <Th>Status</Th>
              <Th className="text-right">Charges posted</Th>
              <Th>Triggered by</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <Td>{TIME.format(r.startedAt)}</Td>
                <Td>{r.fromDate === r.toDate ? r.toDate : `${r.fromDate} → ${r.toDate}`}</Td>
                <Td>
                  <Badge variant={r.status === "succeeded" ? "success" : r.status === "failed" ? "destructive" : "warning"}>{r.status}</Badge>
                  {r.error ? <div className="text-xs text-destructive">{r.error}</div> : null}
                </Td>
                <Td className="text-right">{r.chargesPosted}</Td>
                <Td className="font-mono text-xs">{r.triggeredBy}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

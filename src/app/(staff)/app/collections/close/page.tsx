import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { collectionRateBps } from "@/lib/collections";
import { businessToday, isIsoDate, type IsoDate } from "@/lib/dates";
import { getDayView } from "@/server/money/day-close";
import { closeDayAction } from "../actions";

export const metadata = { title: "Close the day" };

const pct = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(1)}%`);

/** End-of-day close: charged vs collected, and cash collected vs remitted per collector. */
export default async function CloseDayPage({ searchParams }: PageProps<"/app/collections/close">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const canClose = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const sp = await searchParams;
  const today = businessToday();
  const date = (typeof sp.date === "string" && isIsoDate(sp.date) && sp.date <= today ? sp.date : today) as IsoDate;
  const v = await withUserTx(session.claims, (tx) => getDayView(tx, date));
  const changed = v.close && (v.close.collectedCentavos !== v.collected || v.close.remittedCentavos !== v.remitted || v.close.boundaryChargedCentavos !== v.boundaryCharged);

  return (
    <>
      <PageHeader
        title="Close the day"
        description="Compare what was charged with what was collected, and check that every collector remitted their cash."
        actions={
          <Button asChild variant="outline">
            <Link href="/app/collections/remittances">Remittances</Link>
          </Button>
        }
      />
      <form className="mb-4 flex gap-2">
        <Input type="date" name="date" defaultValue={date} max={today} className="w-44" />
        <Button type="submit" variant="outline">Go</Button>
      </form>
      {v.close ? (
        <p role="status" className="mb-4 rounded-md bg-success/15 p-3 text-sm">
          Closed {v.close.closedAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" })}.
          {v.close.notes ? ` Note: ${v.close.notes}` : ""}
          {changed ? (
            <strong className="block text-destructive">
              Payments changed after the close: collected was <Money value={v.close.collectedCentavos} />, now <Money value={v.collected} />; remitted was{" "}
              <Money value={v.close.remittedCentavos} />, now <Money value={v.remitted} />.
            </strong>
          ) : null}
        </p>
      ) : null}
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Card><CardHeader><CardDescription>Boundary charged</CardDescription><CardTitle className="text-xl"><Money value={v.boundaryCharged} /></CardTitle></CardHeader></Card>
        <Card>
          <CardHeader>
            <CardDescription>Collected (all accounts)</CardDescription>
            <CardTitle className="text-xl"><Money value={v.collected} /></CardTitle>
            <p className="text-xs text-muted-foreground">Rate vs boundary charged: {pct(collectionRateBps(v.collected, v.boundaryCharged))}</p>
          </CardHeader>
        </Card>
        <Card><CardHeader><CardDescription>Cash remitted</CardDescription><CardTitle className="text-xl"><Money value={v.remitted} /></CardTitle></CardHeader></Card>
        <Card className={v.unremitted > BigInt(0) ? "border-warning" : ""}>
          <CardHeader><CardDescription>Cash not yet remitted</CardDescription><CardTitle className="text-xl"><Money value={v.unremitted} /></CardTitle></CardHeader>
        </Card>
      </div>
      <Card className="mb-6">
        <Table>
          <thead>
            <tr>
              <Th>Collector</Th>
              <Th className="text-right">Payments</Th>
              <Th className="text-right">Collected</Th>
              <Th className="text-right">Non-cash</Th>
              <Th className="text-right">Cash</Th>
              <Th className="text-right">Remitted</Th>
              <Th className="text-right">Not remitted</Th>
            </tr>
          </thead>
          <tbody>
            {v.collectors.length === 0 ? (
              <tr><Td colSpan={7} className="text-center text-muted-foreground">No payments that day.</Td></tr>
            ) : null}
            {v.collectors.map((c) => (
              <tr key={c.collectorId}>
                <Td>{c.name}</Td>
                <Td className="text-right">{c.payments}</Td>
                <Td className="text-right"><Money value={c.collected} /></Td>
                <Td className="text-right"><Money value={c.nonCash} /></Td>
                <Td className="text-right"><Money value={c.cash} /></Td>
                <Td className="text-right"><Money value={c.remitted} /></Td>
                <Td className="text-right">
                  {c.unremitted > BigInt(0) ? <Badge variant="warning"><Money value={c.unremitted} /></Badge> : <Money value={c.unremitted} />}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {canClose && !v.close ? (
        <ActionForm action={closeDayAction} className="flex max-w-lg flex-wrap gap-2">
          <input type="hidden" name="date" value={date} />
          <Input name="notes" placeholder="Notes (e.g. explain any variance)" className="flex-1" />
          <Button type="submit">Close {date}</Button>
        </ActionForm>
      ) : null}
    </>
  );
}

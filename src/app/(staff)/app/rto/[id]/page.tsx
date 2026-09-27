import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { drivers, vehicles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { businessToday, formatBusinessDate, type IsoDate } from "@/lib/dates";
import { monthlyAmortization, rtoSchedule } from "@/lib/rto";
import { getRtoStatus } from "@/server/money/rto";
import { closeContractAction, terminateContractAction } from "../actions";

export const metadata = { title: "RTO contract" };

export default async function RtoContractPage({ params }: PageProps<"/app/rto/[id]">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const canManage = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const today = businessToday();
  const data = await withUserTx(session.claims, async (tx) => {
    const st = await getRtoStatus(tx, id, today);
    if (!st) return null;
    const [d] = await tx.select().from(drivers).where(eq(drivers.id, st.contract.driverId));
    const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, st.contract.vehicleId));
    return { st, d, v };
  });
  if (!data) notFound();
  const { st, d, v } = data;
  const { contract: c, progress, quote } = st;
  // Map each scheduled installment to its posted charge (if posted) for paid status.
  const posted = new Map(st.allocation.charges.map((ch) => [ch.dueDate + ch.amount.toString(), ch]));
  const schedule = rtoSchedule(st.terms);

  return (
    <>
      <PageHeader
        title={`${c.contractNo}`}
        description={`${d.firstName} ${d.lastName} · ${v.plateNo} ${v.make} ${v.model}`}
        actions={<Badge className="self-center" variant={c.status === "active" ? "success" : "muted"}>{c.status.replace("_", " ")}</Badge>}
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Contract price</CardDescription>
            <CardTitle className="text-xl"><Money value={c.contractPriceCentavos} /></CardTitle>
            <p className="text-xs text-muted-foreground">Down payment <Money value={c.downPaymentCentavos} /> · {c.termMonths} months</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Monthly amortization</CardDescription>
            <CardTitle className="text-xl"><Money value={monthlyAmortization(st.terms)} /></CardTitle>
            <p className="text-xs text-muted-foreground">No interest</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Paid</CardDescription>
            <CardTitle className="text-xl"><Money value={progress.paid} /></CardTitle>
            <ProgressBar percent={progress.percentPaid} label="Contract paid" />
            <p className="text-xs text-muted-foreground">{progress.percentPaid.toFixed(1)}% · {progress.installmentsFullyPaid}/{c.termMonths} installments</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Remaining principal</CardDescription>
            <CardTitle className="text-xl"><Money value={progress.remaining} /></CardTitle>
            <p className="text-xs text-muted-foreground">
              {progress.nextDue
                ? `${progress.nextDue.dueDate < today ? "Overdue since" : "Next"}: ${formatBusinessDate(progress.nextDue.dueDate)}`
                : "Nothing left to pay"} · ends {formatBusinessDate(progress.scheduledCompletion)}
            </p>
            {st.missed > 0 ? <Badge variant={st.missed >= 3 ? "destructive" : "warning"}>{st.missed} missed amortization(s)</Badge> : null}
          </CardHeader>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cashout (early buyout)</CardTitle>
            <CardDescription>Remaining principal only: no discounts, fees or minimum months.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1">
              <dt>Remaining principal</dt><dd className="text-right"><Money value={quote.remainingPrincipal} /></dd>
              <dt className="text-muted-foreground">of which past due</dt><dd className="text-right"><Money value={quote.arrears} /></dd>
              <dt className="text-muted-foreground">Discount / fees</dt><dd className="text-right"><Money value={BigInt(0)} /></dd>
              <dt className="font-semibold">Payoff today</dt><dd className="text-right font-semibold"><Money value={quote.payoff} /></dd>
            </dl>
            {st.overpaid > BigInt(0) ? <p className="text-warning">Overpaid by <Money value={st.overpaid} />: arrange a refund or move it to another account with an adjustment.</p> : null}
            <form action={`/app/rto/${c.id}/cashout`} target="_blank" className="flex flex-wrap items-end gap-2">
              <Field label="Quote as of" htmlFor="asOf">
                <Input id="asOf" name="asOf" type="date" defaultValue={today} />
              </Field>
              <Button type="submit" variant="outline" size="sm">Cashout statement (PDF)</Button>
            </form>
            {canManage && c.status === "active" ? (
              <>
                <p className="text-xs text-muted-foreground">
                  To cash out: record the payoff with <Link className="underline" href={`/app/collections/new?driver=${c.driverId}`}>Record payment</Link> on the
                  Amortization account, then close the contract here.
                </p>
                <ActionForm action={closeContractAction}>
                  <input type="hidden" name="contractId" value={c.id} />
                  <Button type="submit" disabled={quote.remainingPrincipal > BigInt(0)}>
                    Close contract &amp; transfer ownership
                  </Button>
                </ActionForm>
              </>
            ) : null}
            {c.closedOn ? <p>Closed {c.closedOn}: {c.closeReason}</p> : null}
          </CardContent>
        </Card>
        {canManage && c.status === "active" ? (
          <Card>
            <CardHeader>
              <CardTitle>Terminate contract</CardTitle>
              <CardDescription>For example, repossession. Future installments stop; unpaid dues stay on the driver&apos;s account.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={terminateContractAction} className="flex gap-2">
                <input type="hidden" name="contractId" value={c.id} />
                <Input name="reason" placeholder="Reason" required />
                <Button type="submit" variant="destructive">Terminate</Button>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payment schedule</CardTitle>
          <CardDescription>
            Posted to the driver&apos;s Amortization account on each due date. Payments fill the oldest installment first. <Link href={`/app/drivers/${c.driverId}`} className="underline">Driver statement</Link>
          </CardDescription>
        </CardHeader>
        <Table>
          <thead>
            <tr><Th>#</Th><Th>Due</Th><Th className="text-right">Amount</Th><Th className="text-right">Paid</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {schedule.map((i) => {
              const ch = posted.get(i.dueDate + i.amount.toString());
              return (
                <tr key={i.seq}>
                  <Td>{i.kind === "down_payment" ? "DP" : i.seq}</Td>
                  <Td>{formatBusinessDate(i.dueDate as IsoDate)}</Td>
                  <Td className="text-right"><Money value={i.amount} /></Td>
                  <Td className="text-right">{ch ? <Money value={ch.paid} /> : null}</Td>
                  <Td>
                    {ch ? (
                      <Badge variant={ch.status === "paid" ? "success" : ch.dueDate < today ? "destructive" : ch.status === "partial" ? "warning" : "muted"}>
                        {ch.status === "paid" ? "paid" : ch.dueDate < today ? "missed" : ch.status}
                      </Badge>
                    ) : c.status === "active" ? (
                      <span className="text-xs text-muted-foreground">upcoming</span>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

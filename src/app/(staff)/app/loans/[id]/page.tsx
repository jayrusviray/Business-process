import { eq } from "drizzle-orm";
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
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday, formatBusinessDate } from "@/lib/dates";
import { toDecimalString } from "@/lib/money";
import { getLoanStatus } from "@/server/money/loans";
import { recordLoanPaymentAction, reverseLoanPaymentAction } from "../actions";

export const metadata = { title: "Vehicle loan" };

export default async function LoanPage({ params }: PageProps<"/app/loans/[id]">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const today = businessToday();
  const data = await withUserTx(session.claims, async (tx) => {
    const s = await getLoanStatus(tx, id, today);
    if (!s) return null;
    const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, s.loan.vehicleId));
    return { s, v };
  });
  if (!data) notFound();
  const { s, v } = data;
  const { loan } = s;
  return (
    <>
      <PageHeader
        title={`${v.plateNo} · ${loan.lender}`}
        description={`${(loan.annualRateBps / 100).toFixed(2)}% per year, diminishing balance · ${loan.termMonths} months`}
        actions={<Badge className="self-center">{loan.status.replace("_", " ")}</Badge>}
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Card><CardHeader><CardDescription>Loan amount</CardDescription><CardTitle className="text-xl"><Money value={loan.principalCentavos} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Paid</CardDescription><CardTitle className="text-xl"><Money value={s.totalPaid} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Remaining payments</CardDescription><CardTitle className="text-xl"><Money value={s.balance} /></CardTitle></CardHeader></Card>
        <Card>
          <CardHeader>
            <CardDescription>Next due</CardDescription>
            <CardTitle className="text-xl">{s.nextDue ? <Money value={s.nextDue.payment - s.nextDue.paid} /> : "—"}</CardTitle>
            {s.nextDue ? <p className="text-xs text-muted-foreground">{formatBusinessDate(s.nextDue.dueDate)}</p> : null}
            {s.overdue > BigInt(0) ? <Badge variant="destructive">overdue <Money value={s.overdue} /></Badge> : null}
          </CardHeader>
        </Card>
      </div>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Record payment to lender</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={recordLoanPaymentAction} className="grid gap-2 sm:grid-cols-3">
              <input type="hidden" name="loanId" value={loan.id} />
              <Field label="Paid on" htmlFor="paidOn"><Input id="paidOn" name="paidOn" type="date" defaultValue={today} required /></Field>
              <Field label="Amount" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" defaultValue={s.nextDue ? toDecimalString(s.nextDue.payment - s.nextDue.paid) : ""} required /></Field>
              <Field label="Reference" htmlFor="reference"><Input id="reference" name="reference" /></Field>
              <Button type="submit" className="justify-self-start">Record</Button>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {s.payments.length === 0 ? <li className="py-2 text-muted-foreground">None yet.</li> : null}
              {s.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                  <span>{p.paidOn} {p.reference ? `· ${p.reference}` : ""}{p.notes ? <span className="block text-xs text-muted-foreground">{p.notes}</span> : null}</span>
                  <span className="flex items-center gap-2">
                    <Money value={p.amountCentavos} className={p.reversed ? "line-through" : ""} />
                    {!p.reversed && !p.reversesPaymentId ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">Reverse</summary>
                        <ActionForm action={reverseLoanPaymentAction} className="mt-1 flex gap-1">
                          <input type="hidden" name="loanId" value={loan.id} />
                          <input type="hidden" name="paymentId" value={p.id} />
                          <Input name="reason" placeholder="Reason" className="h-8" required />
                          <Button type="submit" size="sm" variant="destructive">Reverse</Button>
                        </ActionForm>
                      </details>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Amortization schedule</CardTitle>
          <CardDescription><Link className="underline" href={`/app/vehicles/${v.id}`}>Vehicle profitability</Link></CardDescription>
        </CardHeader>
        <Table>
          <thead>
            <tr><Th>#</Th><Th>Due</Th><Th className="text-right">Principal</Th><Th className="text-right">Interest</Th><Th className="text-right">Payment</Th><Th className="text-right">Balance after</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.seq}>
                <Td>{l.seq}</Td>
                <Td>{formatBusinessDate(l.dueDate)}</Td>
                <Td className="text-right"><Money value={l.principal} /></Td>
                <Td className="text-right"><Money value={l.interest} /></Td>
                <Td className="text-right"><Money value={l.payment} /></Td>
                <Td className="text-right"><Money value={l.closing} /></Td>
                <Td>
                  <Badge variant={l.status === "paid" ? "success" : l.overdue ? "destructive" : l.status === "partial" ? "warning" : "muted"}>
                    {l.status === "paid" ? "paid" : l.overdue ? "overdue" : l.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

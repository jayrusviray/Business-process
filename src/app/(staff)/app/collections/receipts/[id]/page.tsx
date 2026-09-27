import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { appSettings, driverAccounts, drivers, paymentLines, payments, paymentVoids, profiles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { voidPaymentAction } from "../../actions";

export const metadata = { title: "Acknowledgement receipt" };

const LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;
const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

/** Printable acknowledgement receipt (owner: acknowledgement receipts only, not BIR ORs). */
export default async function ReceiptPage({ params, searchParams }: PageProps<"/app/collections/receipts/[id]">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const { id } = await params;
  const { saved } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withUserTx(session.claims, async (tx) => {
    const [row] = await tx
      .select({ p: payments, d: drivers, collector: profiles.fullName })
      .from(payments)
      .innerJoin(drivers, eq(drivers.id, payments.driverId))
      .innerJoin(profiles, eq(profiles.id, payments.collectorId))
      .where(eq(payments.id, id));
    if (!row) return null;
    const lines = await tx
      .select({ amount: paymentLines.amountCentavos, kind: driverAccounts.kind })
      .from(paymentLines)
      .innerJoin(driverAccounts, eq(driverAccounts.id, paymentLines.accountId))
      .where(eq(paymentLines.paymentId, id));
    const [v] = await tx.select().from(paymentVoids).where(eq(paymentVoids.paymentId, id));
    const [company] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "company.profile"));
    return { ...row, lines, voided: v, company: (company?.value ?? { name: "TransRev" }) as { name: string; address?: string; phone?: string } };
  });
  if (!data) notFound();
  const { p, d, collector, lines, voided, company } = data;

  return (
    <div className="mx-auto max-w-md">
      {saved ? (
        <p role="status" className="mb-3 rounded-md bg-success/15 p-3 text-sm">
          Payment recorded.{" "}
          <Link href="/app/collections/new" className="underline">
            Record another
          </Link>
        </p>
      ) : null}
      <Card className="print:border-0 print:shadow-none">
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="text-center">
            <div className="text-lg font-semibold">{company.name}</div>
            {company.address ? <div className="text-xs text-muted-foreground">{company.address}</div> : null}
            <div className="mt-2 text-sm font-medium uppercase tracking-wide">Acknowledgement receipt</div>
            <div className="font-mono text-sm">{p.receiptNo}</div>
            {voided ? <Badge variant="destructive" className="mt-2">VOID: {voided.reason}</Badge> : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Received from</dt>
            <dd>{d.firstName} {d.lastName}</dd>
            <dt className="text-muted-foreground">Date</dt>
            <dd>{TIME.format(p.receivedAt)}</dd>
            <dt className="text-muted-foreground">Method</dt>
            <dd>
              {p.method.replace("_", " ")}
              {p.referenceNo ? ` · ${p.bankName ? `${p.bankName} ` : ""}${p.referenceNo}` : ""}
            </dd>
            <dt className="text-muted-foreground">Received by</dt>
            <dd>{collector}</dd>
          </dl>
          <table className="w-full text-sm">
            <tbody>
              {lines.map((l) => (
                <tr key={l.kind}>
                  <td className="py-1">{LABEL[l.kind]}</td>
                  <td className="py-1 text-right">
                    <Money value={l.amount} />
                  </td>
                </tr>
              ))}
              <tr className="border-t font-semibold">
                <td className="py-1">Total</td>
                <td className="py-1 text-right">
                  <Money value={p.amountCentavos} />
                </td>
              </tr>
            </tbody>
          </table>
          <p className="text-center text-[11px] text-muted-foreground">This is an acknowledgement receipt, not an official receipt.</p>
          {p.receiptDocumentId ? (
            <Link href={`/app/documents/${p.receiptDocumentId}`} className="text-center text-sm underline print:hidden" target="_blank">
              View attached proof
            </Link>
          ) : null}
        </CardContent>
      </Card>
      <div className="mt-4 flex flex-wrap gap-2 print:hidden">
        <Button asChild variant="outline">
          <Link href={`/app/drivers/${d.id}`}>Driver</Link>
        </Button>
        {hasAnyRole(session.roles, ["owner_admin", "finance"]) && !voided ? (
          <details className="w-full">
            <summary className="cursor-pointer text-sm text-destructive">Void this payment</summary>
            <ActionForm action={voidPaymentAction} className="mt-2 flex gap-2">
              <input type="hidden" name="paymentId" value={p.id} />
              <Input name="reason" placeholder="Reason (required)" required />
              <Button type="submit" variant="destructive">
                Void
              </Button>
            </ActionForm>
          </details>
        ) : null}
      </div>
    </div>
  );
}

import { sql } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { formatPeso } from "@/lib/money";
import { approveProofAction, rejectProofAction } from "../actions";

export const metadata = { title: "Payment proofs" };

const LABEL: Record<string, string> = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" };

type ProofRow = {
  id: string; driver_id: string; driver_name: string; amount: string; method: string; reference_no: string; paid_on: string;
  note: string; document_id: string; status: string; reject_reason: string | null; payment_id: string | null; submitted_at: Date;
};

/** Finance queue: screenshots sent by drivers from the portal, waiting for verification. */
export default async function ProofsPage({ searchParams }: PageProps<"/app/collections/proofs">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const canDecide = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const { show } = await searchParams;
  const pendingOnly = show !== "all";
  const data = await withUserTx(session.claims, async (tx) => {
    const proofs = await tx.execute<ProofRow>(sql`
      SELECT p.id, p.driver_id, d.last_name || ', ' || d.first_name AS driver_name, p.amount_centavos::text AS amount, p.method,
        p.reference_no, p.paid_on::text, p.note, p.document_id, p.status, p.reject_reason, p.payment_id, p.submitted_at
      FROM public.payment_proofs p JOIN public.drivers d ON d.id = p.driver_id
      WHERE ${pendingOnly ? sql`p.status = 'pending'` : sql`true`}
      ORDER BY p.status = 'pending' DESC, p.submitted_at ${pendingOnly ? sql`ASC` : sql`DESC`}
      LIMIT 200`);
    const driverIds = [...new Set(proofs.filter((p) => p.status === "pending").map((p) => p.driver_id))];
    const accounts = driverIds.length
      ? await tx.execute<{ account_id: string; driver_id: string; kind: string; balance: string }>(sql`
          SELECT account_id, driver_id, kind, balance_centavos::text AS balance FROM public.v_account_balances
          WHERE closed_on IS NULL AND driver_id IN (${sql.join(driverIds.map((id) => sql`${id}::uuid`), sql`, `)})
          ORDER BY kind`)
      : [];
    return { proofs, accounts };
  });

  return (
    <>
      <PageHeader
        title="Payment proofs"
        description="GCash, Maya and bank screenshots sent by drivers. Check the reference in the wallet or bank app, then split it across the driver's accounts."
        actions={
          <Button asChild variant="outline">
            <Link href={pendingOnly ? "/app/collections/proofs?show=all" : "/app/collections/proofs"}>{pendingOnly ? "Show decided" : "Waiting only"}</Link>
          </Button>
        }
      />
      {data.proofs.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting for verification.</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.proofs.map((p) => {
          const accts = data.accounts.filter((a) => a.driver_id === p.driver_id);
          return (
            <Card key={p.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>
                      <Link href={`/app/drivers/${p.driver_id}`} className="underline-offset-2 hover:underline">{p.driver_name}</Link>
                    </CardTitle>
                    <CardDescription>
                      Paid {p.paid_on} via {p.method.replace("_", " ")} · ref <span className="font-mono">{p.reference_no}</span>
                    </CardDescription>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold"><Money value={p.amount} /></div>
                    <Badge variant={p.status === "approved" ? "success" : p.status === "rejected" ? "destructive" : "warning"}>{p.status}</Badge>
                  </div>
                </div>
                {p.note ? <p className="text-sm">&ldquo;{p.note}&rdquo;</p> : null}
                {p.reject_reason ? <p className="text-sm text-destructive">Rejected: {p.reject_reason}</p> : null}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <a href={`/app/documents/${p.document_id}`} target="_blank">Open screenshot</a>
                  </Button>
                  {p.payment_id ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/app/collections/receipts/${p.payment_id}`}>Receipt</Link>
                    </Button>
                  ) : null}
                </div>
                {p.status === "pending" && canDecide ? (
                  <>
                    {accts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">This driver has no open accounts. Reject the proof or start a plan first.</p>
                    ) : (
                      <ActionForm action={approveProofAction} className="flex flex-col gap-2 rounded-md border p-3">
                        <input type="hidden" name="proofId" value={p.id} />
                        <p className="text-xs text-muted-foreground">Split {formatPeso(BigInt(p.amount))} across the accounts. It must add up exactly.</p>
                        {accts.map((a, i) => (
                          <label key={a.account_id} className="flex items-center justify-between gap-3 text-sm">
                            <span>
                              {LABEL[a.kind] ?? a.kind}
                              <span className="block text-xs text-muted-foreground">Balance <Money value={a.balance} /></span>
                            </span>
                            <Input
                              name={`amount:${a.account_id}`}
                              inputMode="decimal"
                              placeholder="0.00"
                              defaultValue={i === 0 && accts.length === 1 ? formatPeso(BigInt(p.amount), { symbol: false }) : ""}
                              className="h-11 w-36 text-right"
                            />
                          </label>
                        ))}
                        <Button type="submit">Verify &amp; record payment</Button>
                      </ActionForm>
                    )}
                    <details>
                      <summary className="cursor-pointer text-sm text-destructive">Reject</summary>
                      <ActionForm action={rejectProofAction} className="mt-2 flex gap-2">
                        <input type="hidden" name="proofId" value={p.id} />
                        <Input name="reason" placeholder="Reason the driver will see" required />
                        <Button type="submit" variant="destructive">Reject</Button>
                      </ActionForm>
                    </details>
                  </>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

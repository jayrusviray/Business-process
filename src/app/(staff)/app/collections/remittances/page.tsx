import { sql } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { createRemittanceAction } from "../actions";

export const metadata = { title: "Remittances" };

type Unremitted = { id: string; receipt_no: string; business_date: string; amount_centavos: string; collector_id: string; collector: string; driver_name: string };
type Remit = { id: string; business_date: string; collector: string; expected_centavos: string; remitted_centavos: string; voided_centavos: string; received_by: string; notes: string };

export default async function RemittancesPage() {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const canReceive = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const { unremitted, history } = await withUserTx(session.claims, async (tx) => ({
    unremitted: await tx.execute<Unremitted>(sql`
      SELECT u.id, u.receipt_no, u.business_date::text, u.amount_centavos::text, u.collector_id,
        COALESCE(NULLIF(c.full_name, ''), c.email) AS collector, d.last_name || ', ' || d.first_name AS driver_name
      FROM public.v_unremitted_cash u
      JOIN public.profiles c ON c.id = u.collector_id
      JOIN public.drivers d ON d.id = u.driver_id
      WHERE ${canReceive} OR u.collector_id = ${session.userId}::uuid
      ORDER BY collector, u.business_date, u.receipt_no`),
    history: await tx.execute<Remit>(sql`
      SELECT r.id, r.business_date::text, COALESCE(NULLIF(c.full_name, ''), c.email) AS collector,
        r.expected_centavos::text, r.remitted_centavos::text,
        -- Payments voided after being remitted: the cash never existed, so it shouldn't count as a shortage.
        COALESCE((SELECT SUM(p.amount_centavos) FROM public.remittance_payments rp
          JOIN public.payments p ON p.id = rp.payment_id
          JOIN public.payment_voids v ON v.payment_id = p.id
          WHERE rp.remittance_id = r.id), 0)::text AS voided_centavos,
        COALESCE(NULLIF(rb.full_name, ''), rb.email) AS received_by, r.notes
      FROM public.remittances r
      JOIN public.profiles c ON c.id = r.collector_id
      JOIN public.profiles rb ON rb.id = r.received_by
      ORDER BY r.received_at DESC LIMIT 100`),
  }));

  const byCollector = new Map<string, Unremitted[]>();
  for (const u of unremitted) byCollector.set(u.collector_id, [...(byCollector.get(u.collector_id) ?? []), u]);

  return (
    <>
      <PageHeader title="Collector remittances" description="Cash collected in the field vs. cash handed to the office." />
      {byCollector.size === 0 ? (
        <Card className="mb-6">
          <CardContent className="pt-5 text-sm text-muted-foreground">No unremitted cash.</CardContent>
        </Card>
      ) : null}
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {[...byCollector.entries()].map(([collectorId, items]) => {
          const total = items.reduce((s, i) => s + BigInt(i.amount_centavos), BigInt(0));
          return (
            <Card key={collectorId}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  {items[0].collector} <Money value={total} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm action={createRemittanceAction} className="flex flex-col gap-3">
                  <input type="hidden" name="collectorId" value={collectorId} />
                  <ul className="divide-y rounded-md border text-sm">
                    {items.map((i) => (
                      <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                        {canReceive ? <input type="checkbox" name="paymentId" value={i.id} defaultChecked className="size-4" aria-label={i.receipt_no} /> : null}
                        <span className="flex-1">
                          {i.driver_name}
                          <span className="block text-xs text-muted-foreground">
                            {i.business_date} · <Link href={`/app/collections/receipts/${i.id}`} className="underline">{i.receipt_no}</Link>
                          </span>
                        </span>
                        <Money value={i.amount_centavos} />
                      </li>
                    ))}
                  </ul>
                  {canReceive ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Cash received" htmlFor={`remitted-${collectorId}`}>
                        <Input id={`remitted-${collectorId}`} name="remitted" inputMode="decimal" required />
                      </Field>
                      <Field label="Notes" htmlFor={`notes-${collectorId}`}>
                        <Input id={`notes-${collectorId}`} name="notes" />
                      </Field>
                      <Button type="submit" className="col-span-2">
                        Receive remittance
                      </Button>
                    </div>
                  ) : null}
                </ActionForm>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <h2 className="mb-2 text-lg font-semibold">History</h2>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Collector</Th>
              <Th className="text-right">Expected</Th>
              <Th className="text-right">Remitted</Th>
              <Th className="text-right">Variance</Th>
              <Th>Received by</Th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => {
              const voided = BigInt(r.voided_centavos);
              const variance = BigInt(r.remitted_centavos) - (BigInt(r.expected_centavos) - voided);
              return (
                <tr key={r.id}>
                  <Td>{r.business_date}</Td>
                  <Td>{r.collector}</Td>
                  <Td className="text-right">
                    <Money value={r.expected_centavos} />
                    {voided > BigInt(0) ? (
                      <div className="text-xs text-muted-foreground">
                        less voided <Money value={voided} />
                      </div>
                    ) : null}
                  </Td>
                  <Td className="text-right"><Money value={r.remitted_centavos} /></Td>
                  <Td className="text-right">
                    {variance === BigInt(0) ? <Badge variant="success">exact</Badge> : <Badge variant={variance < BigInt(0) ? "destructive" : "warning"}><Money value={variance} /></Badge>}
                  </Td>
                  <Td>{r.received_by}{r.notes ? <div className="text-xs text-muted-foreground">{r.notes}</div> : null}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

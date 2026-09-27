import { sql } from "drizzle-orm";
import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday, isIsoDate } from "@/lib/dates";

export const metadata = { title: "Collections" };

type Row = {
  id: string; receipt_no: string; driver_id: string; driver_name: string; amount_centavos: string; method: string;
  reference_no: string | null; collector: string; voided: boolean; remitted: boolean;
};

export default async function CollectionsPage({ searchParams }: PageProps<"/app/collections">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const sp = await searchParams;
  const date = typeof sp.date === "string" && isIsoDate(sp.date) ? sp.date : businessToday();
  const { rows, expected } = await withUserTx(session.claims, async (tx) => ({
    rows: await tx.execute<Row>(sql`
      SELECT p.id, p.receipt_no, p.driver_id, d.last_name || ', ' || d.first_name AS driver_name, p.amount_centavos::text,
        p.method, p.reference_no, COALESCE(NULLIF(c.full_name, ''), c.email) AS collector,
        EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id) AS voided,
        EXISTS (SELECT 1 FROM public.remittance_payments rp WHERE rp.payment_id = p.id) AS remitted
      FROM public.payments p
      JOIN public.drivers d ON d.id = p.driver_id
      JOIN public.profiles c ON c.id = p.collector_id
      WHERE p.business_date = ${date}::date
      ORDER BY p.received_at DESC`),
    expected: await tx.execute<{ due: string; charged: string }>(sql`
      SELECT COUNT(*)::text AS charged, COALESCE(SUM(amount_centavos), 0)::text AS due
      FROM public.v_charge_status WHERE entry_type = 'boundary_charge' AND due_date = ${date}::date`),
  }));
  const live = rows.filter((r) => !r.voided);
  const total = live.reduce((s, r) => s + BigInt(r.amount_centavos), BigInt(0));
  const byMethod = new Map<string, bigint>();
  for (const r of live) byMethod.set(r.method, (byMethod.get(r.method) ?? BigInt(0)) + BigInt(r.amount_centavos));

  return (
    <>
      <PageHeader
        title="Collections"
        description={`Payments recorded for ${date}.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/app/collections/new">Record payment</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/app/collections/bulk">Bulk entry</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/app/collections/remittances">Remittances</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/app/collections/charges">Daily charges</Link>
            </Button>
          </div>
        }
      />
      <form className="mb-4 flex gap-2">
        <Input type="date" name="date" defaultValue={date} className="w-44" />
        <Button type="submit" variant="outline">
          Go
        </Button>
      </form>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Collected</CardDescription>
            <CardTitle className="text-2xl"><Money value={total} /></CardTitle>
            <p className="text-xs text-muted-foreground">{live.length} payment(s)</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Boundary charged that day</CardDescription>
            <CardTitle className="text-2xl"><Money value={expected[0]?.due ?? "0"} /></CardTitle>
            <p className="text-xs text-muted-foreground">{expected[0]?.charged ?? 0} driver-day(s)</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>By method</CardDescription>
            <div className="text-sm">
              {[...byMethod.entries()].map(([m, v]) => (
                <div key={m} className="flex justify-between">
                  <span>{m.replace("_", " ")}</span>
                  <Money value={v} />
                </div>
              ))}
              {byMethod.size === 0 ? <span className="text-muted-foreground">—</span> : null}
            </div>
          </CardHeader>
        </Card>
      </div>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Driver</Th>
              <Th>Method</Th>
              <Th>Collector</Th>
              <Th className="text-right">Amount</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={6} className="text-center text-muted-foreground">No payments recorded.</Td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id}>
                <Td><Link href={`/app/collections/receipts/${r.id}`} className="font-mono text-xs underline">{r.receipt_no}</Link></Td>
                <Td><Link href={`/app/drivers/${r.driver_id}`} className="underline-offset-2 hover:underline">{r.driver_name}</Link></Td>
                <Td>{r.method.replace("_", " ")}{r.reference_no ? <div className="text-xs text-muted-foreground">{r.reference_no}</div> : null}</Td>
                <Td>{r.collector}</Td>
                <Td className="text-right"><Money value={r.amount_centavos} className={r.voided ? "line-through" : ""} /></Td>
                <Td>
                  {r.voided ? <Badge variant="destructive">void</Badge> : r.method === "cash" ? (
                    <Badge variant={r.remitted ? "success" : "warning"}>{r.remitted ? "remitted" : "not remitted"}</Badge>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

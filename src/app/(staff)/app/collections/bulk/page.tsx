import { sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { listCollectors } from "@/server/queries/staff";
import { bulkPaymentsAction } from "../actions";

export const metadata = { title: "Bulk entry" };

type Row = { driver_id: string; name: string; plate_no: string | null; account_id: string; rate: string | null; balance: string };

/**
 * End-of-day posting that replaces the spreadsheet: one row per driver, boundary
 * account only. The whole batch is saved in one transaction (all or nothing), and
 * each row carries its own idempotency key, so re-submitting never double-posts.
 */
export default async function BulkEntryPage() {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const today = businessToday();
  const { rows, collectors } = await withUserTx(session.claims, async (tx) => ({
    rows: await tx.execute<Row>(sql`
      SELECT d.id AS driver_id, d.last_name || ', ' || d.first_name AS name, v.plate_no, a.id AS account_id,
        p.daily_rate_centavos::text AS rate,
        COALESCE((SELECT SUM(e.amount_centavos) FROM public.ledger_entries e WHERE e.account_id = a.id), 0)::text AS balance
      FROM public.drivers d
      JOIN public.driver_accounts a ON a.driver_id = d.id AND a.kind = 'boundary' AND a.closed_on IS NULL
      LEFT JOIN public.boundary_plans p ON p.driver_id = d.id AND p.effective_to IS NULL
      LEFT JOIN public.vehicle_assignments va ON va.driver_id = d.id AND va.end_date IS NULL
      LEFT JOIN public.vehicles v ON v.id = va.vehicle_id
      WHERE d.status IN ('active', 'suspended')
      ORDER BY d.last_name, d.first_name`),
    collectors: await listCollectors(tx),
  }));

  return (
    <>
      <PageHeader title="Bulk entry" description="Enter today's boundary collections for many drivers at once. Blank rows are skipped." />
      <ActionForm action={bulkPaymentsAction} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" htmlFor="businessDate">
            <Input id="businessDate" name="businessDate" type="date" defaultValue={today} max={today} required />
          </Field>
          <Field label="Received by" htmlFor="collectorId">
            <Select id="collectorId" name="collectorId" defaultValue={session.userId}>
              {collectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Driver</Th>
                <Th className="text-right">Rate</Th>
                <Th className="text-right">Balance</Th>
                <Th className="w-36">Amount</Th>
                <Th className="w-32">Method</Th>
                <Th className="w-36">Reference</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.account_id}>
                  <Td>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">{r.plate_no ?? "no vehicle"}</div>
                    <input type="hidden" name={`driver:${r.account_id}`} value={r.driver_id} />
                    <input type="hidden" name={`req:${r.account_id}`} value={crypto.randomUUID()} />
                  </Td>
                  <Td className="text-right">{r.rate ? <Money value={r.rate} /> : "—"}</Td>
                  <Td className="text-right"><Money value={r.balance} signed /></Td>
                  <Td>
                    <Input name={`amount:${r.account_id}`} inputMode="decimal" aria-label={`Amount for ${r.name}`} />
                  </Td>
                  <Td>
                    <Select name={`method:${r.account_id}`} defaultValue="cash" aria-label={`Method for ${r.name}`}>
                      <option value="cash">Cash</option>
                      <option value="gcash">GCash</option>
                      <option value="maya">Maya</option>
                      <option value="bank_transfer">Bank</option>
                      <option value="other">Other</option>
                    </Select>
                  </Td>
                  <Td>
                    <Input name={`ref:${r.account_id}`} aria-label={`Reference for ${r.name}`} />
                  </Td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="text-center text-muted-foreground">No drivers with a boundary account.</Td>
                </tr>
              ) : null}
            </tbody>
          </Table>
        </Card>
        <Button type="submit" size="lg" className="self-start">
          Post all
        </Button>
      </ActionForm>
    </>
  );
}

import { asc, desc, sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { commissionsReceived, vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { createReferralAction, recordReceivedAction, referralStepAction, voidReceivedAction } from "./actions";

export const metadata = { title: "Commissions" };

type Referral = { id: string; contract_no: string; driver: string; referrer_type: string; referrer_name: string; base: string; rate_bps: number; amount: string; payable_on: string; status: string; paid_on: string | null; paid_reference: string | null; void_reason: string | null };

export default async function CommissionsPage() {
  const session = await requireRole(["owner_admin", "finance"]);
  const today = businessToday();
  const data = await withUserTx(session.claims, async (tx) => ({
    referrals: await tx.execute<Referral>(sql`
      SELECT r.id, c.contract_no, d.last_name || ', ' || d.first_name AS driver, r.referrer_type, r.referrer_name,
        r.base_centavos::text AS base, r.rate_bps, r.amount_centavos::text AS amount, r.payable_on::text, r.status, r.paid_on::text, r.paid_reference, r.void_reason
      FROM public.referral_commissions r JOIN public.rto_contracts c ON c.id = r.rto_contract_id JOIN public.drivers d ON d.id = c.driver_id
      ORDER BY r.created_at DESC`),
    contracts: await tx.execute<{ id: string; label: string }>(sql`
      SELECT c.id, c.contract_no || ' – ' || d.last_name || ', ' || d.first_name AS label
      FROM public.rto_contracts c JOIN public.drivers d ON d.id = c.driver_id
      WHERE c.down_payment_centavos > 0 AND NOT EXISTS (SELECT 1 FROM public.referral_commissions r WHERE r.rto_contract_id = c.id)
      ORDER BY c.created_at DESC`),
    drivers: await tx.execute<{ id: string; name: string }>(sql`SELECT id, last_name || ', ' || first_name AS name FROM public.drivers ORDER BY 2`),
    received: await tx.select().from(commissionsReceived).orderBy(desc(commissionsReceived.receivedOn)).limit(100),
    vehicleRows: await tx.select({ id: vehicles.id, plate: vehicles.plateNo }).from(vehicles).orderBy(asc(vehicles.plateNo)),
  }));

  return (
    <>
      <PageHeader title="Commissions" description="Referral commissions TransRev pays (10% of the down payment, payable after one month) and commissions TransRev receives." />
      <div className="mb-6 grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card className="self-start">
          <CardHeader><CardTitle>New referral commission</CardTitle><CardDescription>Rate and waiting period come from Settings.</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={createReferralAction} className="grid gap-2">
              <Field label="Referred driver's contract" htmlFor="rtoContractId">
                <Select id="rtoContractId" name="rtoContractId" required>
                  <option value="">Choose…</option>
                  {data.contracts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </Select>
              </Field>
              <Field label="Referrer type" htmlFor="referrerType">
                <Select id="referrerType" name="referrerType"><option value="external">External</option><option value="driver">Driver</option><option value="employee">Employee</option></Select>
              </Field>
              <Field label="Referrer name" htmlFor="referrerName"><Input id="referrerName" name="referrerName" required /></Field>
              <Field label="Referrer mobile" htmlFor="referrerPhone"><Input id="referrerPhone" name="referrerPhone" type="tel" /></Field>
              <Field label="If the referrer is a driver" htmlFor="referrerDriverId">
                <Select id="referrerDriverId" name="referrerDriverId"><option value="">—</option>{data.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
              </Field>
              <Button type="submit" className="justify-self-start">Record</Button>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Referral commissions</CardTitle></CardHeader>
          <Table>
            <thead><tr><Th>Referrer</Th><Th>Referred</Th><Th className="text-right">Commission</Th><Th>Payable</Th><Th>Status</Th></tr></thead>
            <tbody>
              {data.referrals.length === 0 ? <tr><Td colSpan={5} className="text-muted-foreground">None yet.</Td></tr> : null}
              {data.referrals.map((r) => (
                <tr key={r.id}>
                  <Td>{r.referrer_name}<div className="text-xs text-muted-foreground">{r.referrer_type}</div></Td>
                  <Td>{r.driver}<div className="text-xs text-muted-foreground">{r.contract_no}</div></Td>
                  <Td className="text-right"><Money value={r.amount} /><div className="text-xs text-muted-foreground">{r.rate_bps / 100}% of <Money value={r.base} /></div></Td>
                  <Td>{r.payable_on}</Td>
                  <Td>
                    <Badge variant={r.status === "paid" ? "success" : r.status === "void" ? "muted" : r.payable_on <= today ? "warning" : "default"}>{r.status}</Badge>
                    {r.status === "paid" ? <div className="text-xs text-muted-foreground">{r.paid_on} {r.paid_reference}</div> : null}
                    {r.status === "pending" ? (
                      <ActionForm action={referralStepAction} inlineStatus className="mt-1 flex gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="step" value="approve" />
                        <Button type="submit" size="sm" variant="outline" disabled={r.payable_on > today}>Approve</Button>
                      </ActionForm>
                    ) : null}
                    {r.status === "approved" ? (
                      <ActionForm action={referralStepAction} inlineStatus className="mt-1 flex gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="step" value="pay" />
                        <Input name="reference" placeholder="Reference" className="h-8 w-28" />
                        <Button type="submit" size="sm">Paid</Button>
                      </ActionForm>
                    ) : null}
                    {r.status === "pending" || r.status === "approved" ? (
                      <details className="mt-1"><summary className="cursor-pointer text-xs text-muted-foreground">Void</summary>
                        <ActionForm action={referralStepAction} className="mt-1 flex gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="step" value="void" />
                          <Input name="reason" placeholder="Reason" className="h-8" required />
                          <Button type="submit" size="sm" variant="destructive">Void</Button>
                        </ActionForm>
                      </details>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card className="self-start">
          <CardHeader><CardTitle>Commission received</CardTitle><CardDescription>From platforms (e.g. inDrive) or dealers.</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={recordReceivedAction} className="grid gap-2">
              <Field label="From" htmlFor="sourceType"><Select id="sourceType" name="sourceType"><option value="platform">Platform</option><option value="dealer">Dealer</option><option value="other">Other</option></Select></Field>
              <Field label="Who" htmlFor="counterparty"><Input id="counterparty" name="counterparty" required /></Field>
              <Field label="For what" htmlFor="description"><Input id="description" name="description" required /></Field>
              <Field label="Amount" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" required /></Field>
              <Field label="Received on" htmlFor="receivedOn"><Input id="receivedOn" name="receivedOn" type="date" defaultValue={today} required /></Field>
              <Field label="Reference" htmlFor="reference"><Input id="reference" name="reference" /></Field>
              <Field label="Vehicle (optional)" htmlFor="rvehicle"><Select id="rvehicle" name="vehicleId"><option value="">—</option>{data.vehicleRows.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</Select></Field>
              <Button type="submit" className="justify-self-start">Record</Button>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <Table>
            <thead><tr><Th>Date</Th><Th>From</Th><Th>For</Th><Th className="text-right">Amount</Th><Th /></tr></thead>
            <tbody>
              {data.received.length === 0 ? <tr><Td colSpan={5} className="text-muted-foreground">None yet.</Td></tr> : null}
              {data.received.map((r) => (
                <tr key={r.id} className={r.voidedAt ? "text-muted-foreground" : ""}>
                  <Td>{r.receivedOn}</Td>
                  <Td>{r.counterparty}<div className="text-xs">{r.sourceType}</div></Td>
                  <Td>{r.description}<div className="text-xs text-muted-foreground">{r.reference}</div></Td>
                  <Td className="text-right"><Money value={r.amountCentavos} className={r.voidedAt ? "line-through" : ""} /></Td>
                  <Td>{r.voidedAt ? <Badge variant="muted">void</Badge> : (
                    <details><summary className="cursor-pointer text-xs text-muted-foreground">Void</summary>
                      <ActionForm action={voidReceivedAction} className="mt-1 flex gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <Input name="reason" placeholder="Reason" className="h-8" required />
                        <Button type="submit" size="sm" variant="destructive">Void</Button>
                      </ActionForm>
                    </details>
                  )}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}

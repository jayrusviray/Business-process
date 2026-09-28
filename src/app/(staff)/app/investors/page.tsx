import { asc, sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { parseMonthParam } from "@/components/boundary-calendar";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { MonthNav } from "@/components/month-nav";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { investors, vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { addMonths, businessToday, endOfMonth } from "@/lib/dates";
import { assignVehicleAction, generatePayoutsAction, payPayoutAction, saveInvestorAction } from "./actions";

export const metadata = { title: "Investors" };

type Payout = { id: string; investor: string; plate: string; driver: string | null; daily_rate: string; amort: string; days: number; computed: string; payable: string; status: string; paid_on: string | null; reference: string | null };

export default async function InvestorsPage({ searchParams }: PageProps<"/app/investors">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const sp = await searchParams;
  const month = parseMonthParam(sp.month, addMonths(businessToday(), -1));
  const data = await withUserTx(session.claims, async (tx) => ({
    list: await tx.select().from(investors).orderBy(asc(investors.name)),
    vehicleRows: await tx.select({ id: vehicles.id, plate: vehicles.plateNo, investorId: vehicles.investorId }).from(vehicles).orderBy(asc(vehicles.plateNo)),
    payouts: await tx.execute<Payout>(sql`
      SELECT p.id, i.name AS investor, v.plate_no AS plate, d.first_name || ' ' || d.last_name AS driver,
        p.daily_rate_centavos::text AS daily_rate, p.monthly_amortization_centavos::text AS amort, p.boundary_days AS days,
        p.computed_centavos::text AS computed, p.payable_centavos::text AS payable, p.status, p.paid_on::text, p.reference
      FROM public.investor_payouts p JOIN public.investors i ON i.id = p.investor_id JOIN public.vehicles v ON v.id = p.vehicle_id
      LEFT JOIN public.drivers d ON d.id = p.driver_id
      WHERE p.month = ${month}::date ORDER BY i.name, v.plate_no`),
  }));
  const total = data.payouts.reduce((s, p) => s + BigInt(p.payable), BigInt(0));

  return (
    <>
      <PageHeader
        title="Investors"
        description="Monthly share per vehicle = 22 × the driver's daily boundary − the driver's monthly RTO amortization. No percentage split."
        actions={<MonthNav month={month} href={(m) => `/app/investors?month=${m}`} />}
      />
      <Card className="mb-6">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Payouts for {month.slice(0, 7)} · <Money value={total} /></CardTitle>
            <ActionForm action={generatePayoutsAction} inlineStatus className="flex items-center gap-2">
              <input type="hidden" name="month" value={month.slice(0, 7)} />
              <Button type="submit" variant="outline">{data.payouts.length ? "Recompute drafts" : "Compute this month"}</Button>
            </ActionForm>
          </div>
          <CardDescription>
            The driver is the one on the vehicle at month end (or last during the month). Paid rows never change.{" "}
            <a className="underline" href={`/app/reports/investor-statement/export?format=pdf&from=${month}&to=${endOfMonth(month)}`} target="_blank">Statements for this month (PDF)</a>
            {" · "}
            <a className="underline" href={`/app/reports/investor-statement?from=${month}&to=${endOfMonth(month)}`}>per investor</a>
          </CardDescription>
        </CardHeader>
        <Table>
          <thead><tr><Th>Investor</Th><Th>Vehicle / driver</Th><Th className="text-right">Daily × days</Th><Th className="text-right">Less amortization</Th><Th className="text-right">Share</Th><Th>Status</Th></tr></thead>
          <tbody>
            {data.payouts.length === 0 ? <tr><Td colSpan={6} className="text-muted-foreground">Not computed yet.</Td></tr> : null}
            {data.payouts.map((p) => (
              <tr key={p.id}>
                <Td>{p.investor}</Td>
                <Td>{p.plate}<div className="text-xs text-muted-foreground">{p.driver ?? "no driver"}</div></Td>
                <Td className="text-right"><Money value={BigInt(p.daily_rate) * BigInt(p.days)} /><div className="text-xs text-muted-foreground">{p.days} × <Money value={p.daily_rate} /></div></Td>
                <Td className="text-right"><Money value={p.amort} /></Td>
                <Td className="text-right">
                  <Money value={p.payable} className="font-semibold" />
                  {BigInt(p.computed) < BigInt(0) ? <div><Badge variant="destructive">computed <Money value={p.computed} /></Badge></div> : null}
                </Td>
                <Td>
                  {p.status === "paid" ? (
                    <Badge variant="success">paid {p.paid_on}</Badge>
                  ) : (
                    <ActionForm action={payPayoutAction} inlineStatus className="flex gap-1">
                      <input type="hidden" name="id" value={p.id} />
                      <Input name="reference" placeholder="Reference" className="h-8 w-28" />
                      <Button type="submit" size="sm">Paid</Button>
                    </ActionForm>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Investors</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.list.map((i) => (
              <details key={i.id} className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">{i.name} <span className="text-sm font-normal text-muted-foreground">{i.phone}</span></summary>
                <ActionForm action={saveInvestorAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                  <input type="hidden" name="id" value={i.id} />
                  <Field label="Name" htmlFor={`n-${i.id}`}><Input id={`n-${i.id}`} name="name" defaultValue={i.name} required /></Field>
                  <Field label="Mobile" htmlFor={`p-${i.id}`}><Input id={`p-${i.id}`} name="phone" defaultValue={i.phone} /></Field>
                  <Field label="Email" htmlFor={`e-${i.id}`}><Input id={`e-${i.id}`} name="email" defaultValue={i.email ?? ""} /></Field>
                  <Field label="Notes" htmlFor={`no-${i.id}`}><Input id={`no-${i.id}`} name="notes" defaultValue={i.notes} /></Field>
                  <Button type="submit" size="sm" className="justify-self-start">Save</Button>
                </ActionForm>
              </details>
            ))}
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">Add investor</summary>
              <ActionForm action={saveInvestorAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Name" htmlFor="invName"><Input id="invName" name="name" required /></Field>
                <Field label="Mobile" htmlFor="invPhone"><Input id="invPhone" name="phone" /></Field>
                <Field label="Email" htmlFor="invEmail"><Input id="invEmail" name="email" /></Field>
                <Field label="Notes" htmlFor="invNotes"><Input id="invNotes" name="notes" /></Field>
                <Button type="submit" size="sm" className="justify-self-start">Add</Button>
              </ActionForm>
            </details>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Vehicles by investor</CardTitle></CardHeader>
          <Table>
            <thead><tr><Th>Vehicle</Th><Th>Investor</Th></tr></thead>
            <tbody>
              {data.vehicleRows.map((v) => (
                <tr key={v.id}>
                  <Td>{v.plate}</Td>
                  <Td>
                    <ActionForm action={assignVehicleAction} inlineStatus className="flex gap-1">
                      <input type="hidden" name="vehicleId" value={v.id} />
                      <Select name="investorId" defaultValue={v.investorId ?? ""} className="h-8" aria-label={`Investor for ${v.plate}`}>
                        <option value="">Company-owned</option>
                        {data.list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </Select>
                      <Button type="submit" size="sm" variant="ghost">Save</Button>
                    </ActionForm>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}

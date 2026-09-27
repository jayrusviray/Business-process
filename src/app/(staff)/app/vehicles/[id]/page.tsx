import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/money";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { clients, drivers, franchises, vehicleAssignments, vehicleMaintenance, vehicles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { expiryLevel } from "@/lib/applications";
import { addDays, businessToday } from "@/lib/dates";
import { vehicleProfitability } from "@/server/queries/profitability";
import { numberSetting } from "@/server/queries/settings";
import { addFranchise, addMaintenanceAction, updateVehicle, voidMaintenanceAction } from "../actions";
import { VehicleForm } from "../vehicle-form";

export const metadata = { title: "Vehicle" };

const POWERTRAIN_LABEL = { ice: "ICE", ev: "EV", hybrid: "Hybrid" } as const;

function ExpiryBadge({ date, today, urgentBy, warnBy }: { date: string | null; today: string; urgentBy: string; warnBy: string }) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  const level = expiryLevel(date, today, urgentBy, warnBy);
  return level ? (
    <Badge variant={level === "warn" ? "warning" : "destructive"}>
      {level === "expired" ? "expired " : ""}
      {date}
    </Badge>
  ) : (
    <span>{date}</span>
  );
}

export default async function VehiclePage({ params }: PageProps<"/app/vehicles/[id]">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const canEdit = hasAnyRole(session.roles, ["owner_admin", "operations"]);
  const canSeeProfit = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const data = await withUserTx(session.claims, async (tx) => {
    const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, id));
    if (!vehicle) return null;
    const history = await tx
      .select({ a: vehicleAssignments, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(vehicleAssignments)
      .innerJoin(drivers, eq(drivers.id, vehicleAssignments.driverId))
      .where(eq(vehicleAssignments.vehicleId, id))
      .orderBy(desc(vehicleAssignments.startDate));
    const fr = await tx
      .select({ f: franchises, clientName: clients.name })
      .from(franchises)
      .leftJoin(clients, eq(clients.id, franchises.clientId))
      .where(eq(franchises.vehicleId, id))
      .orderBy(desc(franchises.expiresOn));
    const clientOptions = canEdit ? await tx.select({ id: clients.id, name: clients.name }).from(clients).orderBy(clients.name).limit(500) : [];
    const [warnDays, urgentDays] = await Promise.all([
      numberSetting(tx, "alerts.document_expiry_warn_days", 60),
      numberSetting(tx, "alerts.document_expiry_urgent_days", 30),
    ]);
    const profit = canSeeProfit ? await vehicleProfitability(tx, id, businessToday()) : [];
    const maintenance = await tx
      .select({ m: vehicleMaintenance, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(vehicleMaintenance)
      .leftJoin(drivers, eq(drivers.id, vehicleMaintenance.driverId))
      .where(eq(vehicleMaintenance.vehicleId, id))
      .orderBy(desc(vehicleMaintenance.serviceDate), desc(vehicleMaintenance.createdAt));
    return { vehicle, history, fr, profit, maintenance, clientOptions, warnDays, urgentDays };
  });
  if (!data) notFound();
  const { vehicle, history, fr, profit, maintenance, clientOptions, warnDays, urgentDays } = data;
  const today = businessToday();
  const warnBy = addDays(today, warnDays);
  const urgentBy = addDays(today, urgentDays);
  const current = history.find((h) => h.a.endDate === null);

  return (
    <>
      <PageHeader
        title={vehicle.plateNo}
        description={`${vehicle.make} ${vehicle.model} ${vehicle.year ?? ""} · ${POWERTRAIN_LABEL[vehicle.powertrain]} · ${vehicle.fundingSource}${vehicle.conductionSticker ? ` · CS ${vehicle.conductionSticker}` : ""}`}
        actions={<Badge className="self-center">{vehicle.status}</Badge>}
      />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Assignment history</CardTitle>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <Th>Driver</Th>
                <Th>From</Th>
                <Th>To</Th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <Td colSpan={3} className="text-muted-foreground">
                    Never assigned. Assign from the driver&apos;s page.
                  </Td>
                </tr>
              ) : null}
              {history.map(({ a, firstName, lastName }) => (
                <tr key={a.id}>
                  <Td>
                    <Link href={`/app/drivers/${a.driverId}`} className="underline">
                      {lastName}, {firstName}
                    </Link>
                  </Td>
                  <Td>{a.startDate}</Td>
                  <Td>{a.endDate ?? <Badge variant="success">current</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Franchise &amp; papers</CardTitle>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Number</Th>
                <Th>Operator</Th>
                <Th>Expires</Th>
              </tr>
            </thead>
            <tbody>
              {fr.map(({ f, clientName }) => (
                <tr key={f.id}>
                  <Td>{f.kind}</Td>
                  <Td>{f.number}</Td>
                  <Td>
                    {f.clientId ? (
                      <Link href={`/app/clients/${f.clientId}`} className="underline">
                        {clientName ?? f.operatorName}
                      </Link>
                    ) : (
                      f.operatorName
                    )}
                  </Td>
                  <Td>
                    <ExpiryBadge date={f.expiresOn} today={today} urgentBy={urgentBy} warnBy={warnBy} />
                  </Td>
                </tr>
              ))}
              <tr>
                <Td colSpan={3} className="text-muted-foreground">OR/CR</Td>
                <Td>
                  <ExpiryBadge date={vehicle.orcrExpiresOn} today={today} urgentBy={urgentBy} warnBy={warnBy} />
                </Td>
              </tr>
              <tr>
                <Td colSpan={3} className="text-muted-foreground">Insurance</Td>
                <Td>
                  <ExpiryBadge date={vehicle.insuranceExpiresOn} today={today} urgentBy={urgentBy} warnBy={warnBy} />
                </Td>
              </tr>
            </tbody>
          </Table>
          {canEdit ? (
            <CardContent className="pt-4">
              <ActionForm action={addFranchise} className="grid gap-2 sm:grid-cols-3">
                <input type="hidden" name="vehicleId" value={vehicle.id} />
                <Field label="Type" htmlFor="kind">
                  <Select id="kind" name="kind">
                    <option value="PA">PA</option>
                    <option value="CPC">CPC</option>
                  </Select>
                </Field>
                <Field label="Number" htmlFor="number">
                  <Input id="number" name="number" required />
                </Field>
                <Field label="Operator" htmlFor="operatorName">
                  <Input id="operatorName" name="operatorName" required />
                </Field>
                <Field label="Client (for renewal reminders)" htmlFor="clientId">
                  <Select id="clientId" name="clientId" defaultValue="">
                    <option value="">—</option>
                    {clientOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Issued" htmlFor="issuedOn">
                  <Input id="issuedOn" name="issuedOn" type="date" />
                </Field>
                <Field label="Expires" htmlFor="expiresOn">
                  <Input id="expiresOn" name="expiresOn" type="date" />
                </Field>
                <Button type="submit" variant="outline" size="sm" className="self-end">
                  Add franchise
                </Button>
              </ActionForm>
            </CardContent>
          ) : null}
        </Card>
      </div>
      {canSeeProfit ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Profitability (last 12 months)</CardTitle>
            <CardDescription>
              Collected = the paid part of each month&apos;s dues for this vehicle. Costs: loan payments, expenses tagged to this vehicle, and the investor share (draft or paid).
            </CardDescription>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <Th>Month</Th>
                <Th className="text-right">Boundary due</Th>
                <Th className="text-right">Boundary collected</Th>
                <Th className="text-right">RTO collected</Th>
                <Th className="text-right">Loan paid</Th>
                <Th className="text-right">Expenses</Th>
                <Th className="text-right">Investor share</Th>
                <Th className="text-right">Net</Th>
              </tr>
            </thead>
            <tbody>
              {profit.map((m) => {
                const net = BigInt(m.boundary_collected) + BigInt(m.amortization_collected) - BigInt(m.loan_paid) - BigInt(m.expenses) - BigInt(m.investor_share);
                return (
                  <tr key={m.month}>
                    <Td>{m.month}</Td>
                    <Td className="text-right"><Money value={m.boundary_charged} /></Td>
                    <Td className="text-right"><Money value={m.boundary_collected} /></Td>
                    <Td className="text-right"><Money value={m.amortization_collected} /></Td>
                    <Td className="text-right"><Money value={m.loan_paid} /></Td>
                    <Td className="text-right"><Money value={m.expenses} /></Td>
                    <Td className="text-right"><Money value={m.investor_share} /></Td>
                    <Td className="text-right font-medium"><Money value={net} className={net < BigInt(0) ? "text-destructive" : ""} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Maintenance log</CardTitle>
          <CardDescription>Services and repairs. Drivers bear costs at cost (owner rule), so a repair can be charged to the driver in the same step.</CardDescription>
        </CardHeader>
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Work done</Th>
              <Th>Odometer</Th>
              <Th>Charged to</Th>
              <Th className="text-right">Cost</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {maintenance.length === 0 ? (
              <tr><Td colSpan={6} className="text-muted-foreground">No maintenance recorded.</Td></tr>
            ) : null}
            {maintenance.map(({ m, firstName, lastName }) => (
              <tr key={m.id} className={m.voidedAt ? "text-muted-foreground" : ""}>
                <Td>{m.serviceDate}</Td>
                <Td>
                  {m.description}
                  {m.shop ? <span className="block text-xs text-muted-foreground">{m.shop}</span> : null}
                  {m.receiptDocumentId ? <a className="text-xs underline" href={`/app/documents/${m.receiptDocumentId}`} target="_blank">receipt</a> : null}
                  {m.expenseId ? <Badge variant="muted" className="ml-1">expense</Badge> : null}
                  {m.voidedAt ? <span className="block text-xs text-destructive">Void: {m.voidReason}</span> : null}
                </Td>
                <Td>{m.odometerKm !== null ? `${m.odometerKm.toLocaleString("en-PH")} km` : "—"}</Td>
                <Td>{m.driverId ? <Link href={`/app/drivers/${m.driverId}`} className="underline">{lastName}, {firstName}</Link> : "—"}</Td>
                <Td className="text-right"><Money value={m.costCentavos} className={m.voidedAt ? "line-through" : ""} /></Td>
                <Td>
                  {canSeeProfit && !m.voidedAt ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-destructive">Void</summary>
                      <ActionForm action={voidMaintenanceAction} className="mt-1 flex gap-1">
                        <input type="hidden" name="id" value={m.id} />
                        <input type="hidden" name="vehicleId" value={vehicle.id} />
                        <Input name="reason" placeholder="Reason" required className="h-8" />
                        <Button type="submit" size="sm" variant="destructive">Void</Button>
                      </ActionForm>
                    </details>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <CardContent className="pt-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">Log maintenance</summary>
            <ActionForm action={addMaintenanceAction} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="vehicleId" value={vehicle.id} />
              <Field label="Date" htmlFor="m-date"><Input id="m-date" name="serviceDate" type="date" defaultValue={today} max={today} required /></Field>
              <Field label="Cost (₱)" htmlFor="m-cost"><Input id="m-cost" name="cost" inputMode="decimal" placeholder="0.00" /></Field>
              <Field label="Work done" htmlFor="m-desc" className="sm:col-span-2"><Input id="m-desc" name="description" required placeholder="e.g. Change oil + filter" /></Field>
              <Field label="Shop" htmlFor="m-shop"><Input id="m-shop" name="shop" /></Field>
              <Field label="Odometer (km)" htmlFor="m-odo"><Input id="m-odo" name="odometerKm" inputMode="numeric" /></Field>
              <Field label="Charge to driver at cost" htmlFor="m-driver">
                <Select id="m-driver" name="chargeDriverId" defaultValue={current?.a.driverId ?? ""}>
                  <option value="">Don&apos;t charge a driver</option>
                  {history
                    .filter((h, i, all) => all.findIndex((x) => x.a.driverId === h.a.driverId) === i)
                    .map((h) => (
                      <option key={h.a.driverId} value={h.a.driverId}>
                        {h.lastName}, {h.firstName}{h.a.endDate === null ? " (current)" : ""}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Receipt photo (optional)" htmlFor="m-receipt"><Input id="m-receipt" name="receipt" type="file" accept="image/*,application/pdf" /></Field>
              {canSeeProfit ? (
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" name="bookExpense" className="size-5" /> The company paid the shop: also record it as a &ldquo;Vehicle maintenance&rdquo; expense
                </label>
              ) : null}
              <Button type="submit" className="sm:col-span-2">Save</Button>
            </ActionForm>
          </details>
        </CardContent>
      </Card>
      {canEdit ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Edit vehicle</summary>
          <Card className="mt-3">
            <CardContent className="pt-4 sm:pt-5">
              <VehicleForm action={updateVehicle} vehicle={vehicle} submitLabel="Save changes" />
            </CardContent>
          </Card>
        </details>
      ) : null}
    </>
  );
}

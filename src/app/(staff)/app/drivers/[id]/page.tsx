import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { BoundaryCalendar, parseMonthParam } from "@/components/boundary-calendar";
import { BonusList, DriverSummary, QuotaProgress } from "@/components/driver-summary";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { boundaryPlans, drivers, holidays, payments, paymentVoids, vehicleAssignments, vehicles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { addDays, businessToday, endOfMonth, type IsoDate } from "@/lib/dates";
import { formatPeso, toDecimalString } from "@/lib/money";
import { getDriverOverview } from "@/server/queries/driver-overview";
import {
  adjustmentAction,
  assignVehicleAction,
  endPlanAction,
  portalAccessAction,
  postDriverChargeAction,
  reverseEntryAction,
  startPlanAction,
  unassignVehicleAction,
  updateDriver,
} from "../actions";
import { DriverForm, STATUS_VARIANT } from "../driver-form";

export const metadata = { title: "Driver" };

const ACCOUNT_LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;
const TYPE_LABEL: Record<string, string> = {
  opening_balance: "Opening balance",
  boundary_charge: "Boundary",
  amortization_charge: "Amortization",
  cost_charge: "Driver cost",
  deposit_charge: "Deposit",
  payment: "Payment",
  bonus_credit: "Bonus credit",
  adjustment: "Adjustment",
  reversal: "Reversal",
};

export default async function DriverPage({ params, searchParams }: PageProps<"/app/drivers/[id]">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const today = businessToday();
  const month = parseMonthParam(sp.month, today);
  const canAdjust = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const canAssign = hasAnyRole(session.roles, ["owner_admin", "operations"]);

  const data = await withUserTx(session.claims, async (tx) => {
    const [driver] = await tx.select().from(drivers).where(eq(drivers.id, id));
    if (!driver) return null;
    const [plan] = await tx
      .select()
      .from(boundaryPlans)
      .where(and(eq(boundaryPlans.driverId, id), isNull(boundaryPlans.effectiveTo)));
    const plans = await tx.select().from(boundaryPlans).where(eq(boundaryPlans.driverId, id)).orderBy(desc(boundaryPlans.effectiveFrom));
    const [assignment] = await tx
      .select({ id: vehicleAssignments.id, startDate: vehicleAssignments.startDate, plateNo: vehicles.plateNo, vehicleId: vehicles.id })
      .from(vehicleAssignments)
      .innerJoin(vehicles, eq(vehicles.id, vehicleAssignments.vehicleId))
      .where(and(eq(vehicleAssignments.driverId, id), isNull(vehicleAssignments.endDate)));
    const available = await tx
      .select({ id: vehicles.id, plateNo: vehicles.plateNo, make: vehicles.make, model: vehicles.model })
      .from(vehicles)
      .where(eq(vehicles.status, "available"))
      .orderBy(asc(vehicles.plateNo));
    const monthHolidays = await tx
      .select({ date: holidays.date })
      .from(holidays)
      .where(and(gte(holidays.date, month), lte(holidays.date, endOfMonth(month))));
    const pays = await tx
      .select({ p: payments, voidReason: paymentVoids.reason })
      .from(payments)
      .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
      .where(eq(payments.driverId, id))
      .orderBy(desc(payments.receivedAt))
      .limit(50);
    const overview = (await getDriverOverview(tx, id, today, month))!;
    return { driver, plan, plans, assignment, available, statements: overview.statements, monthHolidays, pays, overview };
  });
  if (!data) notFound();
  const { driver, plan, plans, assignment, available, statements, monthHolidays, pays, overview } = data;

  const boundary = statements.find((s) => s.account.kind === "boundary");
  const reversedIds = new Set(statements.flatMap((s) => s.entries.map((e) => e.reversesEntryId)).filter(Boolean));

  return (
    <>
      <PageHeader
        title={`${driver.firstName} ${driver.lastName}`}
        description={`${driver.phone}${assignment ? ` · ${assignment.plateNo}` : ""}`}
        actions={
          <div className="flex gap-2">
            <Badge variant={STATUS_VARIANT[driver.status]} className="self-center">
              {driver.status}
            </Badge>
            <Button asChild>
              <Link href={`/app/collections/new?driver=${driver.id}`}>Record payment</Link>
            </Button>
          </div>
        }
      />

      <div className="mb-6">
        <DriverSummary o={overview} today={today} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Quota &amp; bonuses</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QuotaProgress o={overview} />
            <BonusList o={overview} />
            <Link href="/app/quotas" className="text-sm underline">
              Enter counts / award bonuses
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Driver portal</CardTitle>
            <CardDescription>
              {driver.profileId
                ? `The driver logs in with ${driver.phone} and their password.`
                : "Give the driver a login (mobile number + temporary password). No SMS is sent: hand the password over in person."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={portalAccessAction} className="flex flex-col gap-2">
              <input type="hidden" name="driverId" value={driver.id} />
              <input type="hidden" name="mode" value={driver.profileId ? "reset" : "grant"} />
              <Button type="submit" variant="outline" size="sm" className="self-start">
                {driver.profileId ? "Reset password" : "Give portal access"}
              </Button>
            </ActionForm>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Statement of account</CardTitle>
            <CardDescription>PDF with balance brought forward.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={`/app/drivers/${driver.id}/statement`} target="_blank" className="flex flex-wrap items-end gap-2">
              <Field label="From" htmlFor="stFrom">
                <Input id="stFrom" name="from" type="date" defaultValue={`${today.slice(0, 7)}-01`} />
              </Field>
              <Field label="To" htmlFor="stTo">
                <Input id="stTo" name="to" type="date" defaultValue={today} />
              </Field>
              <Button type="submit" variant="outline" size="sm">
                Download PDF
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Boundary plan</CardTitle>
            <CardDescription>
              {plan ? (
                <>
                  <Money value={plan.dailyRateCentavos} /> / day · {plan.programType === "rto" ? "Boundary-hulog / RTO" : "Boundary"} · since{" "}
                  {plan.effectiveFrom}
                </>
              ) : (
                "No active plan: no daily charges are posted."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ActionForm action={startPlanAction} className="grid gap-2">
              <input type="hidden" name="driverId" value={driver.id} />
              <div className="grid grid-cols-2 gap-2">
                <Field label={plan ? "New daily rate" : "Daily rate"} htmlFor="dailyRate">
                  <Input id="dailyRate" name="dailyRate" inputMode="decimal" placeholder="700.00" required
                    defaultValue={plan ? toDecimalString(plan.dailyRateCentavos) : ""} />
                </Field>
                <Field label="Starting" htmlFor="effectiveFrom">
                  <Input id="effectiveFrom" name="effectiveFrom" type="date" min={today} defaultValue={plan ? addDays(today, 1) : today} required />
                </Field>
              </div>
              <Field label="Program" htmlFor="programType">
                <Select id="programType" name="programType" defaultValue={plan?.programType ?? "boundary"}>
                  <option value="boundary">Boundary</option>
                  <option value="rto">Boundary-hulog / RTO</option>
                </Select>
              </Field>
              <Button type="submit" variant="outline" size="sm" className="justify-self-start">
                {plan ? "Change rate (new version)" : "Start plan"}
              </Button>
            </ActionForm>
            {plan ? (
              <ActionForm action={endPlanAction} className="flex flex-wrap items-end gap-2 border-t pt-3">
                <input type="hidden" name="driverId" value={driver.id} />
                <Field label="Last chargeable day" htmlFor="lastDay">
                  <Input id="lastDay" name="lastDay" type="date" defaultValue={today} required />
                </Field>
                <Button type="submit" variant="ghost" size="sm">
                  End plan
                </Button>
              </ActionForm>
            ) : null}
            {plans.length > 1 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Plan history</summary>
                <ul className="mt-1 space-y-0.5">
                  {plans.map((p) => (
                    <li key={p.id}>
                      {p.effectiveFrom} → {p.effectiveTo ?? "now"}: {formatPeso(p.dailyRateCentavos)}/day
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Vehicle</CardTitle>
            <CardDescription>
              {assignment ? (
                <>
                  <Link href={`/app/vehicles/${assignment.vehicleId}`} className="underline">
                    {assignment.plateNo}
                  </Link>{" "}
                  since {assignment.startDate}
                </>
              ) : (
                "No vehicle assigned."
              )}
            </CardDescription>
          </CardHeader>
          {canAssign ? (
            <CardContent className="grid gap-4">
              <ActionForm action={assignVehicleAction} className="grid gap-2">
                <input type="hidden" name="driverId" value={driver.id} />
                <Field label={assignment ? "Switch to vehicle" : "Assign vehicle"} htmlFor="vehicleId">
                  <Select id="vehicleId" name="vehicleId" required>
                    {available.length === 0 ? <option value="">No available vehicles</option> : null}
                    {available.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.plateNo} – {v.make} {v.model}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From" htmlFor="startDate">
                  <Input id="startDate" name="startDate" type="date" defaultValue={today} required />
                </Field>
                <Button type="submit" variant="outline" size="sm" className="justify-self-start" disabled={available.length === 0}>
                  Assign
                </Button>
              </ActionForm>
              {assignment ? (
                <ActionForm action={unassignVehicleAction} className="flex flex-wrap items-end gap-2 border-t pt-3">
                  <input type="hidden" name="driverId" value={driver.id} />
                  <Field label="Returned on" htmlFor="returnDay">
                    <Input id="returnDay" name="lastDay" type="date" defaultValue={today} required />
                  </Field>
                  <Button type="submit" variant="ghost" size="sm">
                    Return vehicle
                  </Button>
                </ActionForm>
              ) : null}
            </CardContent>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Boundary calendar</CardTitle>
          </CardHeader>
          <CardContent>
            <BoundaryCalendar
              month={month}
              charges={boundary?.allocation.charges ?? []}
              holidays={new Set(monthHolidays.map((h) => h.date))}
              hrefForMonth={(m: IsoDate) => `/app/drivers/${driver.id}?month=${m.slice(0, 7)}`}
            />
          </CardContent>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Post a driver cost or deposit</CardTitle>
            <CardDescription>Costs are charged at cost. The deposit is non-refundable.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={postDriverChargeAction} className="grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="driverId" value={driver.id} />
              <Field label="Type" htmlFor="kind">
                <Select id="kind" name="kind">
                  <option value="cost_charge">Driver cost</option>
                  <option value="deposit_charge">Deposit</option>
                </Select>
              </Field>
              <Field label="Amount" htmlFor="amount">
                <Input id="amount" name="amount" inputMode="decimal" placeholder="0.00" required />
              </Field>
              <Field label="Due date" htmlFor="dueDate">
                <Input id="dueDate" name="dueDate" type="date" defaultValue={today} required />
              </Field>
              <Field label="Description" htmlFor="memo">
                <Input id="memo" name="memo" placeholder="e.g. Change oil – OR #1234" required />
              </Field>
              <Button type="submit" variant="outline" size="sm" className="justify-self-start">
                Post charge
              </Button>
            </ActionForm>
          </CardContent>
        </Card>

        {canAdjust && statements.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Adjustment / opening balance</CardTitle>
              <CardDescription>Finance and admin only. A reason is required and recorded.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={adjustmentAction} className="grid gap-2 sm:grid-cols-2">
                <input type="hidden" name="driverId" value={driver.id} />
                <Field label="Account" htmlFor="accountId">
                  <Select id="accountId" name="accountId">
                    {statements.map((s) => (
                      <option key={s.account.id} value={s.account.id}>
                        {ACCOUNT_LABEL[s.account.kind]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Type" htmlFor="adjType">
                  <Select id="adjType" name="type">
                    <option value="adjustment">Adjustment</option>
                    <option value="opening_balance">Opening balance</option>
                  </Select>
                </Field>
                <Field label="Direction" htmlFor="direction">
                  <Select id="direction" name="direction">
                    <option value="debit">Driver owes more (debit)</option>
                    <option value="credit">Driver owes less (credit)</option>
                  </Select>
                </Field>
                <Field label="Amount" htmlFor="adjAmount">
                  <Input id="adjAmount" name="amount" inputMode="decimal" required />
                </Field>
                <Field label="Due date (debits)" htmlFor="adjDue">
                  <Input id="adjDue" name="dueDate" type="date" defaultValue={today} required />
                </Field>
                <Field label="Reason" htmlFor="reason">
                  <Input id="reason" name="reason" required />
                </Field>
                <Button type="submit" variant="outline" size="sm" className="justify-self-start">
                  Post adjustment
                </Button>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {statements.map((s) => {
        const statusById = new Map(s.allocation.charges.map((c) => [c.id, c]));
        let running = BigInt(0);
        return (
          <Card key={s.account.id} className="mb-6">
            <CardHeader>
              <CardTitle>{ACCOUNT_LABEL[s.account.kind]} statement</CardTitle>
            </CardHeader>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Entry</Th>
                  <Th className="text-right">Charge</Th>
                  <Th className="text-right">Credit</Th>
                  <Th className="text-right">Balance</Th>
                  <Th>Status</Th>
                  {canAdjust ? <Th /> : null}
                </tr>
              </thead>
              <tbody>
                {s.entries.map((e) => {
                  running += e.amountCentavos;
                  const alloc = statusById.get(e.id);
                  const canReverse = canAdjust && !["payment", "reversal"].includes(e.entryType) && !reversedIds.has(e.id);
                  return (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap">{e.businessDate}</Td>
                      <Td>
                        <div>{TYPE_LABEL[e.entryType]}</div>
                        <div className="text-xs text-muted-foreground">{e.memo}{e.reason ? ` · ${e.reason}` : ""}</div>
                      </Td>
                      <Td className="text-right">{e.amountCentavos > BigInt(0) ? <Money value={e.amountCentavos} /> : null}</Td>
                      <Td className="text-right">{e.amountCentavos < BigInt(0) ? <Money value={-e.amountCentavos} /> : null}</Td>
                      <Td className="text-right">
                        <Money value={running} />
                      </Td>
                      <Td>
                        {reversedIds.has(e.id) ? (
                          <Badge variant="muted">reversed</Badge>
                        ) : alloc ? (
                          <Badge variant={alloc.status === "paid" ? "success" : alloc.status === "partial" ? "warning" : "destructive"}>
                            {alloc.status === "partial" ? `short ${formatPeso(alloc.outstanding)}` : alloc.status}
                          </Badge>
                        ) : null}
                      </Td>
                      {canAdjust ? (
                        <Td>
                          {canReverse ? (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">Reverse</summary>
                              <ActionForm action={reverseEntryAction} className="mt-1 flex gap-1">
                                <input type="hidden" name="driverId" value={driver.id} />
                                <input type="hidden" name="entryId" value={e.id} />
                                <Input name="reason" placeholder="Reason" className="h-8" required />
                                <Button type="submit" size="sm" variant="destructive">
                                  Reverse
                                </Button>
                              </ActionForm>
                            </details>
                          ) : null}
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        );
      })}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Payments</CardTitle>
        </CardHeader>
        <Table>
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Date</Th>
              <Th>Method</Th>
              <Th className="text-right">Amount</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {pays.map(({ p, voidReason }) => (
              <tr key={p.id}>
                <Td>
                  <Link href={`/app/collections/receipts/${p.id}`} className="underline">
                    {p.receiptNo}
                  </Link>
                </Td>
                <Td>{p.businessDate}</Td>
                <Td>
                  {p.method.replace("_", " ")}
                  {p.referenceNo ? <div className="text-xs text-muted-foreground">{p.bankName ? `${p.bankName} ` : ""}{p.referenceNo}</div> : null}
                </Td>
                <Td className="text-right">
                  <Money value={p.amountCentavos} className={voidReason ? "line-through" : ""} />
                </Td>
                <Td>{voidReason ? <Badge variant="destructive">void: {voidReason}</Badge> : <Badge variant="success">posted</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <details className="mb-6">
        <summary className="cursor-pointer text-sm font-medium">Edit driver details</summary>
        <Card className="mt-3">
          <CardContent className="pt-4 sm:pt-5">
            <DriverForm action={updateDriver} driver={driver} submitLabel="Save changes" />
          </CardContent>
        </Card>
      </details>
    </>
  );
}

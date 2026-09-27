import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  bonusAwards,
  boundaryPlans,
  drivers,
  holidays,
  payments,
  rtoContracts,
  paymentVoids,
  quotaResults,
  quotaRules,
  vehicleAssignments,
  vehicles,
} from "@/db/schema";
import { addDays, endOfMonth, startOfMonth, type IsoDate } from "@/lib/dates";
import { countMissed } from "@/lib/ledger/allocation";
import { periodFor, type QuotaPeriod } from "@/lib/quotas";
import { getDriverStatements } from "@/server/money/payments";
import { getRtoStatus } from "@/server/money/rto";

/**
 * Everything the driver dashboard (staff) and the driver portal show.
 * Runs under the caller's RLS: a driver only ever gets their own record.
 */
export async function getDriverOverview(tx: Tx, driverId: string, today: IsoDate, month: IsoDate = startOfMonth(today)) {
  const [driver] = await tx.select().from(drivers).where(eq(drivers.id, driverId));
  if (!driver) return null;
  const [plan] = await tx
    .select()
    .from(boundaryPlans)
    .where(and(eq(boundaryPlans.driverId, driverId), isNull(boundaryPlans.effectiveTo)));
  const [assignment] = await tx
    .select({ startDate: vehicleAssignments.startDate, plateNo: vehicles.plateNo, vehicleId: vehicles.id, make: vehicles.make, model: vehicles.model })
    .from(vehicleAssignments)
    .innerJoin(vehicles, eq(vehicles.id, vehicleAssignments.vehicleId))
    .where(and(eq(vehicleAssignments.driverId, driverId), isNull(vehicleAssignments.endDate)));
  const statements = await getDriverStatements(tx, driverId);
  const upcomingHolidays = await tx
    .select()
    .from(holidays)
    .where(and(gte(holidays.date, startOfMonth(month) < today ? startOfMonth(month) : today), lte(holidays.date, addDays(endOfMonth(month), 7))))
    .orderBy(asc(holidays.date));
  const recentPayments = await tx
    .select({ p: payments, voidReason: paymentVoids.reason })
    .from(payments)
    .leftJoin(paymentVoids, eq(paymentVoids.paymentId, payments.id))
    .where(eq(payments.driverId, driverId))
    .orderBy(desc(payments.receivedAt))
    .limit(30);

  // Quotas: active rules with this period's result, plus recent history.
  const rules = await tx.select().from(quotaRules).where(eq(quotaRules.active, true)).orderBy(asc(quotaRules.name));
  const results = await tx
    .select()
    .from(quotaResults)
    .where(eq(quotaResults.driverId, driverId))
    .orderBy(desc(quotaResults.periodStart))
    .limit(24);
  const quotas = rules.map((rule) => {
    const period = periodFor(rule.period as QuotaPeriod, today);
    const current = results.find((r) => r.ruleId === rule.id && r.periodStart === period.start);
    return { rule, period, value: current?.value ?? BigInt(0), recorded: Boolean(current) };
  });
  const bonuses = await tx
    .select({ b: bonusAwards, ruleName: quotaRules.name, periodStart: quotaResults.periodStart })
    .from(bonusAwards)
    .innerJoin(quotaResults, eq(quotaResults.id, bonusAwards.quotaResultId))
    .innerJoin(quotaRules, eq(quotaRules.id, quotaResults.ruleId))
    .where(eq(bonusAwards.driverId, driverId))
    .orderBy(desc(bonusAwards.paidOn))
    .limit(24);

  const [contract] = await tx
    .select({ id: rtoContracts.id })
    .from(rtoContracts)
    .where(eq(rtoContracts.driverId, driverId))
    .orderBy(desc(rtoContracts.createdAt))
    .limit(1);
  const rto = contract ? await getRtoStatus(tx, contract.id, today) : null;

  const holidaySet = new Set(upcomingHolidays.map((h) => h.date));
  const boundary = statements.find((s) => s.account.kind === "boundary");
  const amortization = statements.find((s) => s.account.kind === "amortization");
  const totalBalance = statements.reduce((s, st) => s + st.allocation.balance, BigInt(0));
  const overdue = statements
    .flatMap((s) => s.allocation.charges)
    .filter((c) => c.outstanding > BigInt(0) && c.dueDate < today)
    .reduce((s, c) => s + c.outstanding, BigInt(0));
  const oldestUnpaid = statements
    .flatMap((s) => s.allocation.charges)
    .filter((c) => c.status !== "paid" && c.dueDate < today)
    .map((c) => c.dueDate)
    .sort()[0] as IsoDate | undefined;
  const todayCharge = boundary?.allocation.charges.find((c) => c.entryType === "boundary_charge" && c.dueDate === today);

  // Next chargeable day after today (skipping holidays), if a plan is running.
  let nextDue: { date: IsoDate; amount: bigint } | null = null;
  if (plan && driver.status === "active") {
    let d = addDays(today, 1);
    for (let i = 0; i < 14 && holidaySet.has(d); i++) d = addDays(d, 1);
    if (!plan.effectiveTo || plan.effectiveTo >= d) nextDue = { date: d, amount: plan.dailyRateCentavos };
  }

  return {
    driver,
    plan,
    assignment,
    statements,
    holidays: upcomingHolidays,
    holidaySet,
    recentPayments,
    quotas,
    bonuses,
    totalBalance,
    overdue,
    oldestUnpaid,
    todayCharge,
    nextDue,
    missedAmortizations: amortization ? countMissed(amortization.allocation, today) : 0,
    rto,
  };
}

export type DriverOverview = NonNullable<Awaited<ReturnType<typeof getDriverOverview>>>;

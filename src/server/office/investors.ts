import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { investorPayouts, rtoContracts, vehicles } from "@/db/schema";
import { endOfMonth, startOfMonth, type IsoDate } from "@/lib/dates";
import { ZERO } from "@/lib/money";
import { investorShare } from "@/lib/office";
import { monthlyAmortization } from "@/lib/rto";
import { MoneyRuleError } from "../money/errors";
import { termsOf } from "../money/rto";
import { getSetting } from "./settings";

export async function setVehicleInvestor(tx: Tx, vehicleId: string, investorId: string | null): Promise<void> {
  const res = await tx
    .update(vehicles)
    .set({ investorId, fundingSource: investorId ? "investor" : "company" })
    .where(eq(vehicles.id, vehicleId))
    .returning({ id: vehicles.id });
  if (res.length === 0) throw new MoneyRuleError("You are not allowed to change this vehicle.");
}

/**
 * Builds (or rebuilds) the draft investor payouts for a month. Owner rule:
 *   share = 22 (setting) × the daily boundary rate of the vehicle's driver
 *           − that driver's monthly RTO amortization for this vehicle.
 * The driver is the one assigned on the last day of the month (or the last one
 * assigned during the month). Paid rows are never touched.
 */
export async function generateInvestorPayouts(tx: Tx, anyDateInMonth: IsoDate): Promise<{ created: number; negative: number }> {
  const month = startOfMonth(anyDateInMonth);
  const end = endOfMonth(month);
  const days = await getSetting(tx, "investors.boundary_days");
  const vs = await tx.select().from(vehicles).where(isNotNull(vehicles.investorId));
  let created = 0;
  let negative = 0;
  for (const v of vs) {
    const [driver] = await tx.execute<{ driver_id: string }>(sql`
      SELECT driver_id FROM public.vehicle_assignments
      WHERE vehicle_id = ${v.id}::uuid AND start_date <= ${end}::date AND (end_date IS NULL OR end_date >= ${month}::date)
      ORDER BY start_date DESC LIMIT 1`);
    let rate = ZERO;
    let amort = ZERO;
    if (driver) {
      const [plan] = await tx.execute<{ rate: string }>(sql`
        SELECT daily_rate_centavos::text AS rate FROM public.boundary_plans
        WHERE driver_id = ${driver.driver_id}::uuid AND effective_from <= ${end}::date AND (effective_to IS NULL OR effective_to >= ${month}::date)
        ORDER BY effective_from DESC LIMIT 1`);
      rate = plan ? BigInt(plan.rate) : ZERO;
      const [c] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM public.rto_contracts
        WHERE driver_id = ${driver.driver_id}::uuid AND vehicle_id = ${v.id}::uuid AND start_date <= ${end}::date
          AND (closed_on IS NULL OR closed_on >= ${month}::date)
        ORDER BY start_date DESC LIMIT 1`);
      if (c) {
        const [contract] = await tx.select().from(rtoContracts).where(eq(rtoContracts.id, c.id));
        amort = monthlyAmortization(termsOf(contract));
      }
    }
    const share = investorShare(rate, amort, days);
    if (share.negative) negative++;
    const values = {
      month,
      vehicleId: v.id,
      investorId: v.investorId!,
      driverId: driver?.driver_id ?? null,
      dailyRateCentavos: rate,
      monthlyAmortizationCentavos: amort,
      boundaryDays: days,
      computedCentavos: share.computed,
      payableCentavos: share.payable,
    };
    const [existing] = await tx.select().from(investorPayouts).where(and(eq(investorPayouts.month, month), eq(investorPayouts.vehicleId, v.id)));
    if (existing?.status === "paid") continue;
    if (existing) await tx.update(investorPayouts).set(values).where(eq(investorPayouts.id, existing.id));
    else {
      await tx.insert(investorPayouts).values(values);
      created++;
    }
  }
  return { created, negative };
}

export async function markInvestorPayoutPaid(tx: Tx, id: string, paidOn: IsoDate, reference: string): Promise<void> {
  const res = await tx
    .update(investorPayouts)
    .set({ status: "paid", paidOn, reference })
    .where(and(eq(investorPayouts.id, id), eq(investorPayouts.status, "draft")))
    .returning({ id: investorPayouts.id });
  if (res.length === 0) throw new MoneyRuleError("Payout not found or already paid.");
}

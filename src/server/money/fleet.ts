import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { boundaryPlans, driverAccounts, vehicleAssignments, vehicles } from "@/db/schema";
import { addDays, type IsoDate } from "@/lib/dates";
import type { Centavos } from "@/lib/money";
import { MoneyRuleError } from "./errors";

type AccountKind = "boundary" | "amortization" | "charges";

/** Serialize all money postings for one driver within the current transaction. */
export async function lockDriver(tx: Tx, driverId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('transrev:driver:' || ${driverId}))`);
}

/** Returns the driver's single boundary/charges account, creating it on first use. */
export async function ensureAccount(
  tx: Tx,
  driverId: string,
  kind: Exclude<AccountKind, "amortization">,
  openedOn: IsoDate,
): Promise<string> {
  const [existing] = await tx
    .select({ id: driverAccounts.id })
    .from(driverAccounts)
    .where(and(eq(driverAccounts.driverId, driverId), eq(driverAccounts.kind, kind)));
  if (existing) return existing.id;
  const [created] = await tx
    .insert(driverAccounts)
    .values({ driverId, kind, openedOn })
    .returning({ id: driverAccounts.id });
  return created.id;
}

export type NewPlanInput = {
  driverId: string;
  programType: "boundary" | "rto";
  dailyRate: Centavos;
  effectiveFrom: IsoDate;
  notes?: string;
};

/**
 * Starts a new boundary plan. If the driver has an open plan, it is ended the
 * day before (rate change = new version). Plans cannot start in the past:
 * historical balances come in as opening balances (import), never as
 * back-dated daily charges.
 */
export async function startBoundaryPlan(tx: Tx, input: NewPlanInput, today: IsoDate): Promise<string> {
  if (input.effectiveFrom < today) throw new MoneyRuleError("A plan cannot start in the past.");
  if (input.dailyRate <= BigInt(0)) throw new MoneyRuleError("The daily boundary must be more than ₱0.00.");
  await lockDriver(tx, input.driverId);

  const [open] = await tx
    .select({ id: boundaryPlans.id, effectiveFrom: boundaryPlans.effectiveFrom })
    .from(boundaryPlans)
    .where(and(eq(boundaryPlans.driverId, input.driverId), isNull(boundaryPlans.effectiveTo)));
  if (open) {
    if (open.effectiveFrom >= input.effectiveFrom) {
      throw new MoneyRuleError("The new plan must start after the current plan's start date.");
    }
    await tx
      .update(boundaryPlans)
      .set({ effectiveTo: addDays(input.effectiveFrom, -1) })
      .where(eq(boundaryPlans.id, open.id));
  }

  const accountId = await ensureAccount(tx, input.driverId, "boundary", input.effectiveFrom);
  await ensureAccount(tx, input.driverId, "charges", input.effectiveFrom);
  const [plan] = await tx
    .insert(boundaryPlans)
    .values({
      driverId: input.driverId,
      accountId,
      programType: input.programType,
      dailyRateCentavos: input.dailyRate,
      effectiveFrom: input.effectiveFrom,
      notes: input.notes ?? "",
    })
    .returning({ id: boundaryPlans.id });
  return plan.id;
}

/** Ends the driver's open plan; the last charged day is `lastDay` (inclusive). */
export async function endBoundaryPlan(tx: Tx, driverId: string, lastDay: IsoDate): Promise<void> {
  await lockDriver(tx, driverId);
  const res = await tx
    .update(boundaryPlans)
    .set({ effectiveTo: lastDay })
    .where(and(eq(boundaryPlans.driverId, driverId), isNull(boundaryPlans.effectiveTo)))
    .returning({ id: boundaryPlans.id });
  if (res.length === 0) throw new MoneyRuleError("This driver has no open plan.");
}

/**
 * Assigns a vehicle from `startDate`. Ends the driver's and the vehicle's
 * current assignments the day before. Overlaps are also blocked by DB constraints.
 */
export async function assignVehicle(
  tx: Tx,
  input: { driverId: string; vehicleId: string; startDate: IsoDate; reason?: string },
): Promise<string> {
  const dayBefore = addDays(input.startDate, -1);
  const open = await tx
    .select({ id: vehicleAssignments.id, startDate: vehicleAssignments.startDate, vehicleId: vehicleAssignments.vehicleId })
    .from(vehicleAssignments)
    .where(
      and(
        isNull(vehicleAssignments.endDate),
        sql`(${vehicleAssignments.driverId} = ${input.driverId} OR ${vehicleAssignments.vehicleId} = ${input.vehicleId})`,
      ),
    );
  for (const a of open) {
    if (a.startDate > dayBefore) throw new MoneyRuleError("An existing assignment starts on or after that date.");
    await tx.update(vehicleAssignments).set({ endDate: dayBefore }).where(eq(vehicleAssignments.id, a.id));
    if (a.vehicleId !== input.vehicleId) {
      await tx.update(vehicles).set({ status: "available" }).where(eq(vehicles.id, a.vehicleId));
    }
  }
  const [row] = await tx
    .insert(vehicleAssignments)
    .values({ driverId: input.driverId, vehicleId: input.vehicleId, startDate: input.startDate, reason: input.reason ?? "" })
    .returning({ id: vehicleAssignments.id });
  await tx.update(vehicles).set({ status: "assigned" }).where(eq(vehicles.id, input.vehicleId));
  return row.id;
}

/** Ends the driver's current vehicle assignment. */
export async function unassignVehicle(tx: Tx, driverId: string, lastDay: IsoDate): Promise<void> {
  const res = await tx
    .update(vehicleAssignments)
    .set({ endDate: lastDay })
    .where(and(eq(vehicleAssignments.driverId, driverId), isNull(vehicleAssignments.endDate)))
    .returning({ vehicleId: vehicleAssignments.vehicleId });
  if (res.length === 0) throw new MoneyRuleError("This driver has no current vehicle.");
  await tx.update(vehicles).set({ status: "available" }).where(eq(vehicles.id, res[0].vehicleId));
}

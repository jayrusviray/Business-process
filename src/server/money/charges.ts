import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, chargeRuns } from "@/db/schema";
import { addDays, daysBetween, type IsoDate } from "@/lib/dates";
import { postAmortizationCharges } from "./rto";

/**
 * Posts the boundary charge for `date` to every eligible driver. Set-based and
 * idempotent: key `boundary:{plan}:{date}` means re-running never double-charges,
 * and a reversed charge is not re-posted.
 *
 * Eligible = a plan covering the date + driver status 'active' (checked at run time)
 * + the date is not in `holidays` (owner rule: charged every day except holidays).
 * The charge is stamped with the vehicle assigned to the driver on that date.
 */
export async function postBoundaryCharges(tx: Tx, date: IsoDate): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.ledger_entries
      (account_id, driver_id, entry_type, amount_centavos, business_date, due_date, vehicle_id, plan_id, idempotency_key, memo)
    SELECT p.account_id, p.driver_id, 'boundary_charge', p.daily_rate_centavos, ${date}::date, ${date}::date,
      (SELECT va.vehicle_id FROM public.vehicle_assignments va
        WHERE va.driver_id = p.driver_id AND va.start_date <= ${date}::date
          AND (va.end_date IS NULL OR va.end_date >= ${date}::date)
        LIMIT 1),
      p.id, 'boundary:' || p.id || ':' || ${date}, 'Daily boundary'
    FROM public.boundary_plans p
    JOIN public.drivers d ON d.id = p.driver_id
    WHERE p.effective_from <= ${date}::date
      AND (p.effective_to IS NULL OR p.effective_to >= ${date}::date)
      AND d.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM public.holidays h WHERE h.date = ${date}::date)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`);
  return rows.length;
}

export type ChargeRunResult = { runId: string; fromDate: IsoDate; toDate: IsoDate; chargesPosted: number };

/**
 * The daily job. Posts charges from the day after the last successful run
 * through `today` (catch-up after outages), capped by
 * `collections.charge_catch_up_max_days`. Must run inside withSystemTx.
 */
export async function runDailyCharges(tx: Tx, today: IsoDate, triggeredBy: string): Promise<ChargeRunResult> {
  // Serialize concurrent runs (cron + manual button).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('transrev:daily-charges'))`);

  const [setting] = await tx
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "collections.charge_catch_up_max_days"));
  const maxDays = typeof setting?.value === "number" ? setting.value : 31;

  const [last] = await tx
    .select({ toDate: chargeRuns.toDate })
    .from(chargeRuns)
    .where(and(eq(chargeRuns.status, "succeeded")))
    .orderBy(desc(chargeRuns.toDate))
    .limit(1);

  let from = last ? addDays(last.toDate as IsoDate, 1) : today;
  if (from > today) from = today; // already ran today: re-run today (idempotent)
  const earliest = addDays(today, -(maxDays - 1));
  if (from < earliest) from = earliest;

  const [run] = await tx
    .insert(chargeRuns)
    .values({ fromDate: from, toDate: today, triggeredBy })
    .returning({ id: chargeRuns.id });

  let posted = 0;
  for (let i = 0; i <= daysBetween(from, today); i++) {
    const day = addDays(from, i);
    posted += await postBoundaryCharges(tx, day);
    // RTO installments are due regardless of holidays or driver status.
    posted += await postAmortizationCharges(tx, day);
  }

  await tx
    .update(chargeRuns)
    .set({ status: "succeeded", chargesPosted: posted, finishedAt: sql`now()` })
    .where(eq(chargeRuns.id, run.id));

  return { runId: run.id, fromDate: from, toDate: today, chargesPosted: posted };
}

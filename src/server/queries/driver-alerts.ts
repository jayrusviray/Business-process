import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { addDays, type IsoDate } from "@/lib/dates";
import { numberSetting } from "./settings";

export type DriverAlert = {
  driver_id: string;
  name: string;
  unpaid_days: number;
  balance: string;
  license_expiry: string | null;
};

export type DriverAlerts = { rows: DriverAlert[]; unpaidDaysAt: number; balanceAt: bigint; licenseDays: number };

/**
 * Drivers to follow up (spec 4.1): N boundary days unpaid, total balance at or
 * above a threshold, or a licence expiring soon. Payments are applied oldest
 * due first, so the unpaid boundary days are always the most recent ones: the
 * count of unpaid days is the run of consecutive unpaid days up to today.
 */
export async function driverAlerts(tx: Tx, today: IsoDate): Promise<DriverAlerts> {
  const [unpaidDaysAt, balanceAt, licenseDays] = await Promise.all([
    numberSetting(tx, "alerts.consecutive_unpaid_days", 3),
    numberSetting(tx, "alerts.balance_threshold_centavos", 500000),
    numberSetting(tx, "alerts.license_expiry_days", 30),
  ]);
  const licenseBy = addDays(today, licenseDays);
  const rows = await tx.execute<DriverAlert>(sql`
    WITH unpaid AS (
      SELECT driver_id, COUNT(*)::int AS days FROM public.v_charge_status
      WHERE entry_type = 'boundary_charge' AND status <> 'paid' AND due_date <= ${today}::date
      GROUP BY driver_id
    ), bal AS (
      SELECT driver_id, SUM(balance_centavos)::bigint AS total FROM public.v_account_balances GROUP BY driver_id
    )
    SELECT d.id AS driver_id, d.last_name || ', ' || d.first_name AS name,
      COALESCE(u.days, 0) AS unpaid_days, COALESCE(b.total, 0)::text AS balance, d.license_expiry::text
    FROM public.drivers d
    LEFT JOIN unpaid u ON u.driver_id = d.id
    LEFT JOIN bal b ON b.driver_id = d.id
    WHERE d.status IN ('active', 'suspended')
      AND (COALESCE(u.days, 0) >= ${unpaidDaysAt}
        OR (${balanceAt} > 0 AND COALESCE(b.total, 0) >= ${balanceAt})
        OR d.license_expiry <= ${licenseBy}::date)
    ORDER BY COALESCE(u.days, 0) DESC, COALESCE(b.total, 0) DESC, d.last_name`);
  return { rows, unpaidDaysAt, balanceAt: BigInt(balanceAt), licenseDays };
}

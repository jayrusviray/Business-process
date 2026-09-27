import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { addMonths, startOfMonth, type IsoDate } from "@/lib/dates";

export type VehicleMonth = {
  month: string;
  boundary_charged: string;
  boundary_collected: string;
  amortization_collected: string;
  loan_paid: string;
};

/**
 * Per-vehicle monthly income vs. financing cost (owner/finance only: loan data is RLS-restricted).
 * "Collected" = the paid part of that month's dues (oldest-first allocation), attributed to the
 * vehicle the driver had on each day. Operating expenses per vehicle join in Phase 6.
 */
export async function vehicleProfitability(tx: Tx, vehicleId: string, today: IsoDate, months = 12): Promise<VehicleMonth[]> {
  const from = addMonths(startOfMonth(today), -(months - 1));
  return tx.execute<VehicleMonth>(sql`
    WITH months AS (
      SELECT generate_series(${from}::date, ${startOfMonth(today)}::date, interval '1 month')::date AS m
    ),
    dues AS (
      SELECT date_trunc('month', due_date)::date AS m, entry_type,
        SUM(amount_centavos) AS charged, SUM(paid_centavos) AS paid
      FROM public.v_charge_status
      WHERE vehicle_id = ${vehicleId}::uuid AND due_date >= ${from}::date
      GROUP BY 1, 2
    ),
    loans AS (
      SELECT date_trunc('month', lp.paid_on)::date AS m, SUM(lp.amount_centavos) AS paid
      FROM public.loan_payments lp JOIN public.vehicle_loans l ON l.id = lp.loan_id
      WHERE l.vehicle_id = ${vehicleId}::uuid AND lp.paid_on >= ${from}::date
      GROUP BY 1
    )
    SELECT to_char(months.m, 'YYYY-MM') AS month,
      COALESCE((SELECT charged FROM dues WHERE dues.m = months.m AND entry_type = 'boundary_charge'), 0)::text AS boundary_charged,
      COALESCE((SELECT paid FROM dues WHERE dues.m = months.m AND entry_type = 'boundary_charge'), 0)::text AS boundary_collected,
      COALESCE((SELECT paid FROM dues WHERE dues.m = months.m AND entry_type = 'amortization_charge'), 0)::text AS amortization_collected,
      COALESCE((SELECT paid FROM loans WHERE loans.m = months.m), 0)::text AS loan_paid
    FROM months ORDER BY months.m DESC`);
}

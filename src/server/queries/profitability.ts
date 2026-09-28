import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { addMonths, startOfMonth, type IsoDate } from "@/lib/dates";

export type VehicleMonth = {
  month: string;
  boundary_charged: string;
  boundary_collected: string;
  amortization_collected: string;
  loan_paid: string;
  expenses: string;
  investor_share: string;
};

/**
 * Per-vehicle monthly income vs. financing cost (owner/finance only: loan data is RLS-restricted).
 * "Collected" = the paid part of that month's dues (oldest-first allocation), attributed to the
 * vehicle the driver had on each day. Costs: loan payments, expenses tagged to the vehicle, investor share.
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
    exp AS (
      SELECT date_trunc('month', expense_date)::date AS m, SUM(amount_centavos) AS amt
      FROM public.expenses WHERE vehicle_id = ${vehicleId}::uuid AND voided_at IS NULL AND expense_date >= ${from}::date
      GROUP BY 1
    ),
    inv AS (
      SELECT month AS m, SUM(payable_centavos) AS amt FROM public.investor_payouts
      WHERE vehicle_id = ${vehicleId}::uuid AND month >= ${from}::date GROUP BY 1
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
      COALESCE((SELECT paid FROM loans WHERE loans.m = months.m), 0)::text AS loan_paid,
      COALESCE((SELECT amt FROM exp WHERE exp.m = months.m), 0)::text AS expenses,
      COALESCE((SELECT amt FROM inv WHERE inv.m = months.m), 0)::text AS investor_share
    FROM months ORDER BY months.m DESC`);
}

export type FleetVehicleRow = {
  vehicle_id: string;
  plate_no: string;
  powertrain: string;
  status: string;
  boundary_charged: string;
  boundary_collected: string;
  amortization_collected: string;
  expenses: string;
  loan_paid: string;
  investor_share: string;
};

/**
 * Every vehicle over a period, same definitions as vehicleProfitability:
 * "collected" = the paid part of dues falling due in the period (oldest-first
 * allocation) attributed to the vehicle on the charge. Paid part = charged −
 * what is still open, using app.open_charges (identical rule to v_charge_status,
 * and fast on years of ledger). Costs: vehicle-tagged expenses, loan payments
 * (corrections net out), investor shares of months in the period.
 */
export async function fleetProfitability(tx: Tx, from: IsoDate, to: IsoDate): Promise<FleetVehicleRow[]> {
  return tx.execute<FleetVehicleRow>(sql`
    WITH charged AS (
      SELECT e.vehicle_id, e.entry_type, SUM(e.amount_centavos) AS amt
      FROM public.ledger_entries e
      WHERE e.due_date BETWEEN ${from}::date AND ${to}::date AND e.vehicle_id IS NOT NULL
        AND e.amount_centavos > 0 AND e.entry_type IN ('boundary_charge', 'amortization_charge')
        AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id)
      GROUP BY 1, 2
    ), open AS (
      SELECT vehicle_id, entry_type, SUM(outstanding_centavos) AS amt FROM app.open_charges(NULL)
      WHERE due_date BETWEEN ${from}::date AND ${to}::date AND vehicle_id IS NOT NULL
      GROUP BY 1, 2
    ), exp AS (
      SELECT vehicle_id, SUM(amount_centavos) AS amt FROM public.expenses
      WHERE vehicle_id IS NOT NULL AND voided_at IS NULL AND expense_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1
    ), loans AS (
      SELECT l.vehicle_id, SUM(lp.amount_centavos) AS amt FROM public.loan_payments lp JOIN public.vehicle_loans l ON l.id = lp.loan_id
      WHERE lp.paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1
    ), inv AS (
      SELECT vehicle_id, SUM(payable_centavos) AS amt FROM public.investor_payouts
      WHERE month BETWEEN date_trunc('month', ${from}::date)::date AND ${to}::date GROUP BY 1
    )
    SELECT v.id AS vehicle_id, v.plate_no, v.powertrain::text, v.status::text,
      COALESCE((SELECT amt FROM charged c WHERE c.vehicle_id = v.id AND c.entry_type = 'boundary_charge'), 0)::text AS boundary_charged,
      (COALESCE((SELECT amt FROM charged c WHERE c.vehicle_id = v.id AND c.entry_type = 'boundary_charge'), 0)
        - COALESCE((SELECT amt FROM open o WHERE o.vehicle_id = v.id AND o.entry_type = 'boundary_charge'), 0))::text AS boundary_collected,
      (COALESCE((SELECT amt FROM charged c WHERE c.vehicle_id = v.id AND c.entry_type = 'amortization_charge'), 0)
        - COALESCE((SELECT amt FROM open o WHERE o.vehicle_id = v.id AND o.entry_type = 'amortization_charge'), 0))::text AS amortization_collected,
      COALESCE((SELECT amt FROM exp WHERE exp.vehicle_id = v.id), 0)::text AS expenses,
      COALESCE((SELECT amt FROM loans WHERE loans.vehicle_id = v.id), 0)::text AS loan_paid,
      COALESCE((SELECT amt FROM inv WHERE inv.vehicle_id = v.id), 0)::text AS investor_share
    FROM public.vehicles v
    ORDER BY v.plate_no`);
}

import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";

export type DriverListRow = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  status: string;
  plate_no: string | null;
  daily_rate_centavos: string | null;
  program_type: string | null;
  balance_centavos: string;
  oldest_unpaid_due: string | null;
};

/** Driver list with current vehicle, plan and total balance (RLS applies). */
export async function listDrivers(tx: Tx, opts: { q?: string; status?: string; today: string }): Promise<DriverListRow[]> {
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  return tx.execute<DriverListRow>(sql`
    SELECT d.id, d.first_name, d.last_name, d.phone, d.status,
      v.plate_no, p.daily_rate_centavos::text, p.program_type,
      COALESCE((SELECT SUM(b.balance_centavos) FROM public.v_account_balances b WHERE b.driver_id = d.id), 0)::text AS balance_centavos,
      (SELECT MIN(cs.due_date)::text FROM public.v_charge_status cs
        WHERE cs.driver_id = d.id AND cs.status <> 'paid' AND cs.due_date < ${opts.today}::date) AS oldest_unpaid_due
    FROM public.drivers d
    LEFT JOIN public.vehicle_assignments va ON va.driver_id = d.id AND va.end_date IS NULL
    LEFT JOIN public.vehicles v ON v.id = va.vehicle_id
    LEFT JOIN public.boundary_plans p ON p.driver_id = d.id AND p.effective_to IS NULL
    WHERE (${q}::text IS NULL OR d.first_name ILIKE ${q} OR d.last_name ILIKE ${q} OR d.phone ILIKE ${q} OR v.plate_no ILIKE ${q})
      AND (${opts.status ?? null}::text IS NULL OR d.status::text = ${opts.status ?? null})
    ORDER BY d.last_name, d.first_name
    LIMIT 500`);
}

export type DriverPickRow = { id: string; name: string; plate_no: string | null; phone: string };

export async function listActiveDriversForPicker(tx: Tx): Promise<DriverPickRow[]> {
  return tx.execute<DriverPickRow>(sql`
    SELECT d.id, d.last_name || ', ' || d.first_name AS name, v.plate_no, d.phone
    FROM public.drivers d
    LEFT JOIN public.vehicle_assignments va ON va.driver_id = d.id AND va.end_date IS NULL
    LEFT JOIN public.vehicles v ON v.id = va.vehicle_id
    WHERE d.status IN ('active', 'suspended')
    ORDER BY d.last_name, d.first_name`);
}

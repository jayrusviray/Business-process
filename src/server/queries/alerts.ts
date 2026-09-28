import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { addDays, type IsoDate } from "@/lib/dates";
import type { LoanAlert } from "@/server/money/loans";
import { loanDues } from "./dashboard";
import { numberSetting } from "./settings";

export type FlaggedContract = { contractId: string; contractNo: string; driverId: string; driverName: string; missed: number };

/**
 * Finance alerts: loan dues soon/overdue and drivers at or over the missed-amortization flag.
 * "Missed" = installments due before today not fully paid (same as countMissed), read from
 * app.open_charges in one pass instead of one allocation per contract (M-D performance).
 */
export async function financeAlerts(tx: Tx, today: IsoDate): Promise<{ loans: LoanAlert[]; flagged: FlaggedContract[]; flagAt: number }> {
  const [days, flagAt] = await Promise.all([
    numberSetting(tx, "loans.due_alert_days", 7),
    numberSetting(tx, "collections.delinquency_missed_amortizations", 3),
  ]);
  const flagged = await tx.execute<{ contract_id: string; contract_no: string; driver_id: string; name: string; missed: number }>(sql`
    SELECT c.id AS contract_id, c.contract_no, c.driver_id, d.last_name || ', ' || d.first_name AS name, count(*)::int AS missed
    FROM app.open_charges(NULL) oc
    JOIN public.rto_contracts c ON c.account_id = oc.account_id
    JOIN public.drivers d ON d.id = c.driver_id
    WHERE c.status = 'active' AND oc.entry_type = 'amortization_charge' AND oc.due_date < ${today}::date
    GROUP BY c.id, d.id
    HAVING count(*) >= ${flagAt}
    ORDER BY 5 DESC`);
  return {
    loans: await loanDues(tx, today, addDays(today, days)),
    flagged: flagged.map((f) => ({ contractId: f.contract_id, contractNo: f.contract_no, driverId: f.driver_id, driverName: f.name, missed: f.missed })),
    flagAt,
  };
}

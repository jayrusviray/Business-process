import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { loanDueAlerts, type LoanAlert } from "@/server/money/loans";
import { getRtoStatus } from "@/server/money/rto";

export type FlaggedContract = { contractId: string; contractNo: string; driverId: string; driverName: string; missed: number };

async function numberSetting(tx: Tx, key: string, fallback: number): Promise<number> {
  const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  return typeof row?.value === "number" ? row.value : fallback;
}

/** Finance alerts: loan dues soon/overdue and drivers at or over the missed-amortization flag. */
export async function financeAlerts(tx: Tx, today: IsoDate): Promise<{ loans: LoanAlert[]; flagged: FlaggedContract[]; flagAt: number }> {
  const [days, flagAt] = await Promise.all([
    numberSetting(tx, "loans.due_alert_days", 7),
    numberSetting(tx, "collections.delinquency_missed_amortizations", 3),
  ]);
  const contracts = await tx.execute<{ id: string; contract_no: string; driver_id: string; name: string }>(sql`
    SELECT c.id, c.contract_no, c.driver_id, d.last_name || ', ' || d.first_name AS name
    FROM public.rto_contracts c JOIN public.drivers d ON d.id = c.driver_id WHERE c.status = 'active'`);
  const flagged: FlaggedContract[] = [];
  for (const c of contracts) {
    const s = await getRtoStatus(tx, c.id, today);
    if (s && s.missed >= flagAt) flagged.push({ contractId: c.id, contractNo: c.contract_no, driverId: c.driver_id, driverName: c.name, missed: s.missed });
  }
  return { loans: await loanDueAlerts(tx, today, days), flagged: flagged.sort((a, b) => b.missed - a.missed), flagAt };
}

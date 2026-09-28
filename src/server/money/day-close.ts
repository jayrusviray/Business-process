import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { collectionDayCloses } from "@/db/schema";
import { summarizeDay, type DaySummary } from "@/lib/collections";
import type { IsoDate } from "@/lib/dates";
import { MoneyRuleError } from "./errors";

export type DayView = DaySummary & {
  date: IsoDate;
  boundaryCharged: bigint;
  close: typeof collectionDayCloses.$inferSelect | null;
};

/** What was charged, collected and remitted on a business day, per collector (under RLS). */
export async function getDayView(tx: Tx, date: IsoDate): Promise<DayView> {
  const rows = await tx.execute<{ collector_id: string; name: string; method: string; amount: string; voided: boolean; remitted: boolean }>(sql`
    SELECT p.collector_id, COALESCE(NULLIF(c.full_name, ''), c.email, 'Unknown') AS name, p.method, p.amount_centavos::text AS amount,
      EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id) AS voided,
      EXISTS (SELECT 1 FROM public.remittance_payments rp WHERE rp.payment_id = p.id) AS remitted
    FROM public.payments p JOIN public.profiles c ON c.id = p.collector_id
    WHERE p.business_date = ${date}::date`);
  const [charged] = await tx.execute<{ due: string }>(sql`
    SELECT COALESCE(SUM(e.amount_centavos), 0)::text AS due FROM public.ledger_entries e
    WHERE e.entry_type = 'boundary_charge' AND e.due_date = ${date}::date
      AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id)`);
  const [close] = await tx.select().from(collectionDayCloses).where(eq(collectionDayCloses.businessDate, date));
  const summary = summarizeDay(
    rows.map((r) => ({ collectorId: r.collector_id, collectorName: r.name, method: r.method, amount: BigInt(r.amount), voided: r.voided, remitted: r.remitted })),
  );
  return { ...summary, date, boundaryCharged: BigInt(charged?.due ?? "0"), close: close ?? null };
}

/** Finance closes the day: stores an immutable snapshot of the day's totals. */
export async function closeDay(tx: Tx, input: { date: IsoDate; today: IsoDate; closedBy: string; notes?: string }): Promise<void> {
  if (input.date > input.today) throw new MoneyRuleError("You can't close a day that hasn't happened yet.");
  const v = await getDayView(tx, input.date);
  if (v.close) throw new MoneyRuleError("This day is already closed.");
  await tx.insert(collectionDayCloses).values({
    businessDate: input.date,
    boundaryChargedCentavos: v.boundaryCharged,
    collectedCentavos: v.collected,
    cashCentavos: v.cash,
    remittedCentavos: v.remitted,
    collectors: v.collectors.map((c) => ({
      collectorId: c.collectorId,
      name: c.name,
      payments: c.payments,
      collected: c.collected.toString(),
      cash: c.cash.toString(),
      remitted: c.remitted.toString(),
      unremitted: c.unremitted.toString(),
    })),
    notes: input.notes?.trim() ?? "",
    closedBy: input.closedBy,
  });
}

import { addDays, dayOfWeek, endOfMonth, startOfMonth, type IsoDate } from "./dates";

export type QuotaPeriod = "monthly" | "weekly";
export type QuotaMetric = "trips" | "earnings_centavos" | "boundary_days_paid";

/** The period containing `d`. Weeks run Monday–Sunday. */
export function periodFor(period: QuotaPeriod, d: IsoDate): { start: IsoDate; end: IsoDate } {
  if (period === "monthly") return { start: startOfMonth(d), end: endOfMonth(d) };
  const back = (dayOfWeek(d) + 6) % 7; // Monday = 0
  const start = addDays(d, -back);
  return { start, end: addDays(start, 6) };
}

export function isHit(value: bigint, threshold: bigint): boolean {
  return value >= threshold;
}

/** 0–100 progress towards a threshold, for progress bars. */
export function progressPercent(value: bigint, threshold: bigint): number {
  if (threshold <= BigInt(0)) return 0;
  if (value >= threshold) return 100;
  return Number((value * BigInt(100)) / threshold);
}

export const METRIC_LABEL: Record<QuotaMetric, string> = {
  trips: "rides",
  earnings_centavos: "earnings",
  boundary_days_paid: "fully paid boundary days",
};

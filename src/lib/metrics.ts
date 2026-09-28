import { addDays, addMonths, daysBetween, dayOfWeek, endOfMonth, startOfMonth, type IsoDate } from "./dates";
import { ZERO, type Centavos } from "./money";

/**
 * Pure metrics for dashboards and reports (M-D). Money stays in bigint
 * centavos; rates are basis points (integer, 10000 = 100%).
 */

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------
export type AgingBuckets = {
  /** Due today or later (not yet past due). */
  current: Centavos;
  /** One amount per bucket: 1–L1, L1+1–L2, L2+1–L3, over L3 days past due. */
  buckets: [Centavos, Centavos, Centavos, Centavos];
  total: Centavos;
  labels: [string, string, string, string];
};

export function daysPastDue(dueDate: IsoDate, asOf: IsoDate): number {
  return daysBetween(dueDate, asOf);
}

export function agingLabels(limits: readonly [number, number, number] | readonly number[]): [string, string, string, string] {
  const [a, b, c] = limits;
  return [`1–${a} days`, `${a + 1}–${b} days`, `${b + 1}–${c} days`, `Over ${c} days`];
}

/**
 * Buckets outstanding amounts by days past due as of `asOf`. Default limits
 * [7, 15, 30] give 1–7, 8–15, 16–30 and over 30 days (spec 5; setting
 * `dashboard.aging_bucket_days`).
 */
export function agingBuckets(
  rows: readonly { dueDate: IsoDate; outstanding: Centavos }[],
  asOf: IsoDate,
  limits: readonly number[] = [7, 15, 30],
): AgingBuckets {
  const [l1, l2, l3] = limits;
  const out: AgingBuckets = { current: ZERO, buckets: [ZERO, ZERO, ZERO, ZERO], total: ZERO, labels: agingLabels(limits) };
  for (const r of rows) {
    if (r.outstanding === ZERO) continue;
    out.total += r.outstanding;
    const days = daysPastDue(r.dueDate, asOf);
    if (days <= 0) out.current += r.outstanding;
    else if (days <= l1) out.buckets[0] += r.outstanding;
    else if (days <= l2) out.buckets[1] += r.outstanding;
    else if (days <= l3) out.buckets[2] += r.outstanding;
    else out.buckets[3] += r.outstanding;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
/** a ÷ b in basis points (floor), or null when b is 0. For counts (e.g. lead conversion). */
export function ratioBps(a: number, b: number): number | null {
  if (b <= 0) return null;
  return Math.floor((a * 10000) / b);
}

/** Format basis points as a percentage, e.g. 1234 → "12.3%". */
export function formatBps(bps: number | null, digits = 1): string {
  if (bps === null) return "—";
  return `${(bps / 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// RTO projection
// ---------------------------------------------------------------------------
/**
 * Projected completion at the driver's own pace (information only, not a money
 * rule): average paid per month since the contract start, applied to what is
 * left. Null when nothing has been paid yet; the as-of date when fully paid.
 */
export function projectedCompletion(paid: Centavos, remaining: Centavos, startDate: IsoDate, asOf: IsoDate): IsoDate | null {
  if (remaining <= ZERO) return asOf;
  if (paid <= ZERO) return null;
  const daysElapsed = Math.max(1, daysBetween(startDate, asOf));
  // paid per day = paid / daysElapsed → days left = remaining × daysElapsed / paid (rounded up).
  const daysLeft = (remaining * BigInt(daysElapsed) + paid - BigInt(1)) / paid;
  const capped = daysLeft > BigInt(365 * 50) ? 365 * 50 : Number(daysLeft);
  return addDays(asOf, capped);
}

/** Monthly installments still unpaid (by amount), rounding up; used for "nearing completion". */
export function installmentsLeft(remaining: Centavos, monthlyInstallment: Centavos): number {
  if (remaining <= ZERO) return 0;
  if (monthlyInstallment <= ZERO) return Number.MAX_SAFE_INTEGER;
  return Number((remaining + monthlyInstallment - BigInt(1)) / monthlyInstallment);
}

// ---------------------------------------------------------------------------
// Periods and grouping
// ---------------------------------------------------------------------------
export type PeriodKind = "day" | "week" | "month" | "custom";

/** Monday of the week containing `d`. */
export function startOfWeek(d: IsoDate): IsoDate {
  return addDays(d, -((dayOfWeek(d) + 6) % 7));
}

/** The dashboard period ending today (or a custom range, clamped and ordered). */
export function periodRange(kind: PeriodKind, today: IsoDate, from?: IsoDate | null, to?: IsoDate | null): { from: IsoDate; to: IsoDate } {
  if (kind === "day") return { from: today, to: today };
  if (kind === "week") return { from: startOfWeek(today), to: today };
  if (kind === "month") return { from: startOfMonth(today), to: today };
  const f = from ?? startOfMonth(today);
  const t = to ?? today;
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

export type GroupBy = "day" | "week" | "month";

/** The bucket a date falls in: its own date, the Monday of its week, or the 1st of its month. */
export function bucketStart(d: IsoDate, by: GroupBy): IsoDate {
  if (by === "day") return d;
  if (by === "week") return startOfWeek(d);
  return startOfMonth(d);
}

export function bucketLabel(start: IsoDate, by: GroupBy): string {
  if (by === "day") return start;
  if (by === "week") return `Week of ${start}`;
  return start.slice(0, 7);
}

/** Every bucket start from `from` to `to` (so empty days/weeks/months still show). */
export function bucketsBetween(from: IsoDate, to: IsoDate, by: GroupBy): IsoDate[] {
  const out: IsoDate[] = [];
  let d = bucketStart(from, by);
  while (d <= to) {
    out.push(d);
    d = by === "day" ? addDays(d, 1) : by === "week" ? addDays(d, 7) : addMonths(d, 1, 1);
  }
  return out;
}

/** Last day of a bucket (clamped to `to`). */
export function bucketEnd(start: IsoDate, by: GroupBy, to: IsoDate): IsoDate {
  const end = by === "day" ? start : by === "week" ? addDays(start, 6) : endOfMonth(start);
  return end < to ? end : to;
}

/**
 * Sums bigint fields of rows into groups keyed by `key(row)`, keeping first-seen
 * order. Fields missing on a row count as zero.
 */
export function groupSums<R, K extends string>(
  rows: readonly R[],
  key: (r: R) => string,
  fields: readonly K[],
  value: (r: R, field: K) => Centavos,
): Map<string, { sums: Record<K, Centavos>; count: number }> {
  const out = new Map<string, { sums: Record<K, Centavos>; count: number }>();
  for (const r of rows) {
    const k = key(r);
    let g = out.get(k);
    if (!g) {
      g = { sums: Object.fromEntries(fields.map((f) => [f, ZERO])) as Record<K, Centavos>, count: 0 };
      out.set(k, g);
    }
    for (const f of fields) g.sums[f] = g.sums[f] + value(r, f);
    g.count += 1;
  }
  return out;
}

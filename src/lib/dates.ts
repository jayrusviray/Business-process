/**
 * Business dates. A business date is a calendar date in Asia/Manila, carried as
 * an ISO "YYYY-MM-DD" string (Postgres `date`). Never derive a business date
 * from `new Date().toISOString()` — that is UTC and is wrong from 00:00–07:59 PHT.
 */
export const BUSINESS_TZ = "Asia/Manila";

export type IsoDate = string & { readonly __brand: "IsoDate" };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): s is IsoDate {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isoDate(s: string): IsoDate {
  if (!isIsoDate(s)) throw new RangeError(`Invalid ISO date: "${s}"`);
  return s;
}

const manilaFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Manila calendar date of an instant. */
export function toBusinessDate(instant: Date): IsoDate {
  return manilaFormatter.format(instant) as IsoDate;
}

/** Today's business date in Manila. */
export function businessToday(now: Date = new Date()): IsoDate {
  return toBusinessDate(now);
}

function toUtc(d: IsoDate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10) as IsoDate;
}

export function addDays(d: IsoDate, days: number): IsoDate {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + days);
  return fromUtc(t);
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(d: IsoDate): number {
  return toUtc(d).getUTCDay();
}

/** Inclusive list of dates from `from` to `to`. Empty if to < from. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Add calendar months, clamping to month end (Jan 31 + 1 month = Feb 28/29).
 * Use `anchorDay` to keep a schedule on its original day (e.g. due every 31st
 * → Jan 31, Feb 28, Mar 31) instead of drifting after a clamp.
 */
export function addMonths(d: IsoDate, months: number, anchorDay?: number): IsoDate {
  const [y, m, day] = d.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const wanted = anchorDay ?? day;
  const nd = Math.min(wanted, daysInMonth(ny, nm));
  return fromUtc(new Date(Date.UTC(ny, nm, nd)));
}

/**
 * Whole calendar months elapsed from `a` to `b` (floor), e.g.
 * 2026-01-15 → 2026-04-14 = 2, → 2026-04-15 = 3. Used for delinquency ("3 months").
 */
export function monthsElapsed(a: IsoDate, b: IsoDate): number {
  if (b < a) return -monthsElapsed(b, a);
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  let months = (by - ay) * 12 + (bm - am);
  // Anniversary not yet reached this month (respecting month-end clamping).
  if (addMonths(a, months) > b) months -= 1;
  return months;
}

export function startOfMonth(d: IsoDate): IsoDate {
  return `${d.slice(0, 7)}-01` as IsoDate;
}

export function endOfMonth(d: IsoDate): IsoDate {
  const [y, m] = d.split("-").map(Number);
  return fromUtc(new Date(Date.UTC(y, m, 0)));
}

/** Format for display, e.g. "Sep 27, 2026". */
export function formatBusinessDate(d: IsoDate): string {
  return toUtc(d).toLocaleDateString("en-PH", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

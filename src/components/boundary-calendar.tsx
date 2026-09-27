import Link from "next/link";
import { addMonths, dayOfWeek, eachDay, endOfMonth, isoDate, startOfMonth, type IsoDate } from "@/lib/dates";
import type { AllocatedCharge } from "@/lib/ledger/allocation";
import { formatPeso } from "@/lib/money";
import { cn } from "@/lib/utils";

const STYLE: Record<string, string> = {
  paid: "bg-success/20 text-foreground",
  partial: "bg-warning/30 text-foreground",
  unpaid: "bg-destructive/20 text-foreground",
  holiday: "bg-muted text-muted-foreground",
  none: "text-muted-foreground",
};

/**
 * Boundary compliance calendar for one month: paid / short (partial) / unpaid
 * per day, computed by the FIFO allocation (a late payment fills the oldest day).
 */
export function BoundaryCalendar({
  month,
  charges,
  holidays,
  hrefForMonth,
}: {
  month: IsoDate;
  charges: AllocatedCharge[];
  holidays: Set<string>;
  hrefForMonth: (m: IsoDate) => string;
}) {
  const first = startOfMonth(month);
  const days = eachDay(first, endOfMonth(month));
  const byDay = new Map<string, AllocatedCharge[]>();
  for (const c of charges) {
    if (c.entryType !== "boundary_charge") continue;
    byDay.set(c.dueDate, [...(byDay.get(c.dueDate) ?? []), c]);
  }
  const label = new Date(`${first}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
  const counts = { paid: 0, partial: 0, unpaid: 0 };

  const cells = days.map((d) => {
    const cs = byDay.get(d) ?? [];
    let status = holidays.has(d) ? "holiday" : "none";
    let tip = holidays.has(d) ? "Holiday – no boundary" : "No charge";
    if (cs.length) {
      const amount = cs.reduce((s, c) => s + c.amount, BigInt(0));
      const paid = cs.reduce((s, c) => s + c.paid, BigInt(0));
      status = paid === amount ? "paid" : paid > BigInt(0) ? "partial" : "unpaid";
      counts[status as keyof typeof counts]++;
      tip = `${formatPeso(paid)} of ${formatPeso(amount)} paid`;
    }
    return { d, status, tip };
  });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <Link href={hrefForMonth(addMonths(first, -1))} className="rounded px-2 py-1 hover:bg-muted" aria-label="Previous month">
          ‹
        </Link>
        <span className="font-medium">{label}</span>
        <Link href={hrefForMonth(addMonths(first, 1))} className="rounded px-2 py-1 hover:bg-muted" aria-label="Next month">
          ›
        </Link>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => (
          <div key={i} className="py-1 font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {Array.from({ length: dayOfWeek(first) }, (_, i) => (
          <div key={`pad${i}`} />
        ))}
        {cells.map((c) => (
          <div key={c.d} title={`${c.d}: ${c.tip}`} className={cn("rounded py-2", STYLE[c.status])}>
            {Number(c.d.slice(8))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-success/60" />Paid {counts.paid}</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-warning/70" />Short {counts.partial}</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-destructive/60" />Unpaid {counts.unpaid}</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-muted-foreground/30" />Holiday</span>
      </div>
    </div>
  );
}

export function parseMonthParam(v: unknown, fallback: IsoDate): IsoDate {
  if (typeof v === "string" && /^\d{4}-\d{2}$/.test(v)) {
    try {
      return isoDate(`${v}-01`);
    } catch {
      /* fall through */
    }
  }
  return startOfMonth(fallback);
}

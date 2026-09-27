import Link from "next/link";
import { addMonths, type IsoDate } from "@/lib/dates";

/** ‹ September 2026 › links for pages keyed by ?month=YYYY-MM. */
export function MonthNav({ month, href }: { month: IsoDate; href: (m: string) => string }) {
  const label = new Date(`${month}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="flex items-center gap-2 text-sm">
      <Link href={href(addMonths(month, -1).slice(0, 7))} className="rounded border px-2 py-1" aria-label="Previous month">‹</Link>
      <span className="min-w-36 text-center font-medium">{label}</span>
      <Link href={href(addMonths(month, 1).slice(0, 7))} className="rounded border px-2 py-1" aria-label="Next month">›</Link>
    </div>
  );
}

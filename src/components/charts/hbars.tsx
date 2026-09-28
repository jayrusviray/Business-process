import type { ReactNode } from "react";
import styles from "./charts.module.css";

/**
 * Single-series horizontal bars (aging buckets, leads by source, funnel).
 * Server-rendered HTML: every value is printed at the bar's end, so nothing
 * depends on hover. One colour (series 1): identity comes from the row label.
 */
export function HBars({ rows, ariaLabel }: { rows: { label: string; value: number; display: ReactNode }[]; ariaLabel: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className={`${styles.viz} flex flex-col gap-2 text-sm`} aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-2">
          <span className="truncate text-muted-foreground">{r.label}</span>
          <span className="h-3" aria-hidden>
            {r.value > 0 ? (
              <span
                className="block h-3 rounded-r"
                style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, background: "var(--series-1)", borderTopRightRadius: 4, borderBottomRightRadius: 4 }}
              />
            ) : null}
          </span>
          <span className="money text-right">{r.display}</span>
        </li>
      ))}
    </ul>
  );
}

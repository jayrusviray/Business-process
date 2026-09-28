"use client";

import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import styles from "./charts.module.css";

/**
 * Small client chart components (recharts). Pages stay server-rendered and pass
 * plain numbers of PESOS (converted from exact centavos on the server, display
 * only). Every chart has a legend for 2+ series, a hover tooltip, and the same
 * data as a table on the page.
 */
export type SeriesPoint = { label: string; a: number; b: number };

const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-PH", { notation: "compact", maximumFractionDigits: 1 });

function Legend({ a, b, bIsLine }: { a: string; b: string; bIsLine?: boolean }) {
  return (
    <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
      <span><span className={styles.swatch} style={{ background: "var(--series-1)" }} aria-hidden />{a}</span>
      <span>
        {bIsLine ? <span className={styles.key} style={{ background: "var(--series-2)" }} aria-hidden /> : <span className={styles.swatch} style={{ background: "var(--series-2)" }} aria-hidden />}
        {b}
      </span>
    </div>
  );
}

type TipProps = { active?: boolean; label?: string; payload?: { value?: number; dataKey?: string | number }[]; names: Record<string, string> };

/** Value leads, series name follows, keyed by a short line in the series colour. */
function ChartTooltip({ active, label, payload, names }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      <div className="mb-1 text-muted-foreground">{label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">
            <span className={styles.key} style={{ background: p.dataKey === "a" ? "var(--series-1)" : "var(--series-2)" }} aria-hidden />
            {names[String(p.dataKey)]}
          </span>
          <strong className="money">{peso.format(p.value ?? 0)}</strong>
        </div>
      ))}
    </div>
  );
}

const axisProps = {
  tick: { fill: "var(--ink-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--axis)" },
} as const;

/** Columns (series 1) with a line (series 2) on ONE peso axis, e.g. collected per day vs due per day. */
export function BarLineChart({ data, aName, bName, ariaLabel }: { data: SeriesPoint[]; aName: string; bName: string; ariaLabel: string }) {
  return (
    <div className={styles.viz}>
      <Legend a={aName} b={bName} bIsLine />
      <div className={styles.chart} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={16} />
            <YAxis {...axisProps} axisLine={false} width={48} tickFormatter={(v: number) => compact.format(v)} />
            <Tooltip content={<ChartTooltip names={{ a: aName, b: bName }} />} cursor={{ fill: "var(--grid)", opacity: 0.5 }} />
            <Bar dataKey="a" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
            <Line dataKey="b" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--color-card, #fff)", strokeWidth: 2 }} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Two series side by side per period (e.g. revenue vs expenses per month), one peso axis. */
export function PairedBarChart({ data, aName, bName, ariaLabel }: { data: SeriesPoint[]; aName: string; bName: string; ariaLabel: string }) {
  return (
    <div className={styles.viz}>
      <Legend a={aName} b={bName} />
      <div className={styles.chart} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis {...axisProps} axisLine={false} width={48} tickFormatter={(v: number) => compact.format(v)} />
            <Tooltip content={<ChartTooltip names={{ a: aName, b: bName }} />} cursor={{ fill: "var(--grid)", opacity: 0.5 }} />
            <Bar dataKey="a" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={20} />
            <Bar dataKey="b" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

import type { Tx } from "@/db/client";
import { computeTotals } from "@/lib/reports/format";
import type { ReportDoc } from "./export";
import { columnsFor, periodLabel, type ReportContext, type ReportDef } from "./types";

/** Runs a report as the current user (RLS applies) and packages it for the screen and exports. */
export async function runReport(tx: Tx, def: ReportDef, ctx: ReportContext): Promise<ReportDoc> {
  const columns = columnsFor(def, ctx);
  const res = await def.run(tx, ctx);
  const chosen = Object.entries(ctx.paramLabels)
    .filter(([k, v]) => v && ctx.params[k])
    .map(([, v]) => v);
  return {
    title: def.title,
    subtitle: [periodLabel(def, ctx), ...chosen].join(" · "),
    columns,
    rows: res.rows,
    totals: res.totals === undefined ? computeTotals(columns, res.rows) : res.totals,
    notes: res.notes ?? [],
    landscape: def.landscape,
    generatedAt: new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }),
  };
}

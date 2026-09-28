import type { Tx } from "@/db/client";
import type { Role } from "@/lib/auth/roles";
import { addDays, addMonths, isIsoDate, startOfMonth, endOfMonth, type IsoDate } from "@/lib/dates";
import type { ReportColumn, ReportRow } from "@/lib/reports/format";

/**
 * Report framework (M-D). A report is a definition: who may run it (must match
 * RLS; the queries run as the user anyway), its parameters, its columns and a
 * query. One page (/app/reports/[key]) and one export route (xlsx/pdf/csv)
 * serve every report.
 */
export type ParamOption = { value: string; label: string };

export type ParamDef = {
  key: string;
  label: string;
  /** Fixed choices, or loaded per request (drivers, investors, payroll periods…). */
  options: ParamOption[] | ((tx: Tx) => Promise<ParamOption[]>);
  /** Value when missing/invalid. "" = none chosen (options should include it when allowed). */
  default: string;
};

export type RangePreset = "today" | "this_month" | "last_month" | "last_30_days" | "this_year" | "last_12_months";

export type ReportContext = {
  from: IsoDate;
  to: IsoDate;
  today: IsoDate;
  params: Record<string, string>;
  /** Labels of the chosen options (for titles and PDFs). */
  paramLabels: Record<string, string>;
  userId: string;
  roles: readonly Role[];
};

export type ReportResult = {
  rows: ReportRow[];
  /** Explicit totals; when absent the framework sums columns marked `total`. */
  totals?: ReportRow | null;
  notes?: string[];
};

export type ReportDef = {
  key: string;
  title: string;
  description: string;
  group: "Collections" | "Sales & CRM" | "Office & finance" | "Fleet";
  roles: readonly Role[];
  defaultRange: RangePreset;
  /** "as_of": only the end date matters (balances, aging). */
  rangeKind?: "range" | "as_of";
  params?: ParamDef[];
  columns: ReportColumn[] | ((ctx: ReportContext) => ReportColumn[]);
  run: (tx: Tx, ctx: ReportContext) => Promise<ReportResult>;
  /** Replace the generic export with an existing document (statement PDF, payroll register…). Null = use generic. */
  pdf?: (tx: Tx, ctx: ReportContext) => Promise<{ data: Buffer; filename: string } | null>;
  xlsx?: (tx: Tx, ctx: ReportContext) => Promise<{ data: Buffer; filename: string } | null>;
  landscape?: boolean;
};

export function presetRange(p: RangePreset, today: IsoDate): { from: IsoDate; to: IsoDate } {
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "this_month":
      return { from: startOfMonth(today), to: today };
    case "last_month": {
      const m = addMonths(startOfMonth(today), -1);
      return { from: m, to: endOfMonth(m) };
    }
    case "last_30_days":
      return { from: addDays(today, -29), to: today };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01` as IsoDate, to: today };
    case "last_12_months":
      return { from: addMonths(startOfMonth(today), -11), to: today };
  }
}

export function columnsFor(def: ReportDef, ctx: ReportContext): ReportColumn[] {
  return typeof def.columns === "function" ? def.columns(ctx) : def.columns;
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Reads from/to and the report's parameters from the query string, falling back to defaults. */
export async function resolveContext(
  tx: Tx,
  def: ReportDef,
  sp: Search,
  base: { today: IsoDate; userId: string; roles: readonly Role[] },
): Promise<{ ctx: ReportContext; options: Record<string, ParamOption[]> }> {
  const preset = presetRange(def.defaultRange, base.today);
  const qFrom = one(sp.from);
  const qTo = one(sp.to);
  let to = (isIsoDate(qTo) ? qTo : preset.to) as IsoDate;
  let from = (isIsoDate(qFrom) ? qFrom : preset.from) as IsoDate;
  if (def.rangeKind === "as_of") from = to;
  if (to < from) [from, to] = [to, from];
  const params: Record<string, string> = {};
  const paramLabels: Record<string, string> = {};
  const options: Record<string, ParamOption[]> = {};
  for (const p of def.params ?? []) {
    const opts = typeof p.options === "function" ? await p.options(tx) : p.options;
    options[p.key] = opts;
    const want = one(sp[p.key]);
    const hit = opts.find((o) => o.value === want) ?? opts.find((o) => o.value === p.default);
    params[p.key] = hit?.value ?? p.default;
    paramLabels[p.key] = hit?.label ?? "";
  }
  return { ctx: { from, to, today: base.today, params, paramLabels, userId: base.userId, roles: base.roles }, options };
}

/** Human description of the period for titles and exports. */
export function periodLabel(def: ReportDef, ctx: ReportContext): string {
  if (def.rangeKind === "as_of") return `As of ${ctx.to}`;
  return ctx.from === ctx.to ? ctx.from : `${ctx.from} to ${ctx.to}`;
}

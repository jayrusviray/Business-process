import { formatPeso, toDecimalString, ZERO } from "../money";

/**
 * Report framework: column types and cell formatting shared by the on-screen
 * table and the CSV / Excel / PDF exports. Pure (no server imports).
 *
 *   money  bigint centavos        int   whole number
 *   date   "YYYY-MM-DD" string    pct   basis points (10000 = 100%) or null
 *   text   string
 */
export type ColumnType = "text" | "money" | "int" | "date" | "pct";
export type ReportValue = string | number | bigint | null | undefined;
export type ReportRow = Record<string, ReportValue>;

export type ReportColumn = {
  key: string;
  label: string;
  type: ColumnType;
  /** Sum this column into the totals row (money/int only). */
  total?: boolean;
};

export function isNumeric(type: ColumnType): boolean {
  return type === "money" || type === "int" || type === "pct";
}

function asBigint(v: ReportValue): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return ZERO;
}

/** Display text for a cell (screen). Money uses ₱; PDFs use `pdfCell`. */
export function formatCell(type: ColumnType, v: ReportValue): string {
  if (v === null || v === undefined || v === "") return type === "pct" ? "—" : "";
  switch (type) {
    case "money":
      return formatPeso(asBigint(v));
    case "int":
      return Number(v).toLocaleString("en-PH");
    case "pct":
      return `${(Number(v) / 100).toFixed(1)}%`;
    default:
      return String(v);
  }
}

/** PDF text: the PDF's built-in fonts have no ₱ sign, so money prints as "PHP 1,234.56". */
export function pdfCell(type: ColumnType, v: ReportValue): string {
  if (type === "money" && v !== null && v !== undefined && v !== "") {
    const s = formatPeso(asBigint(v), { symbol: false });
    return s.startsWith("-") ? `-PHP ${s.slice(1)}` : `PHP ${s}`;
  }
  return formatCell(type, v);
}

/** CSV/plain value: money as a decimal string ("1234.50"), pct as a percentage number ("12.34"). */
export function plainCell(type: ColumnType, v: ReportValue): string {
  if (v === null || v === undefined) return "";
  switch (type) {
    case "money":
      return toDecimalString(asBigint(v));
    case "pct":
      return (Number(v) / 100).toFixed(2);
    case "int":
      return String(Number(v));
    default:
      return String(v);
  }
}

function csvEscape(s: string): string {
  // Neutralise spreadsheet formulas in text cells (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** RFC 4180 CSV with a header row and an optional totals row. */
export function toCsv(columns: readonly ReportColumn[], rows: readonly ReportRow[], totals?: ReportRow | null): string {
  const lines = [columns.map((c) => csvEscape(c.label)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvEscape(plainCell(c.type, r[c.key]))).join(","));
  if (totals) lines.push(columns.map((c) => csvEscape(plainCell(c.type, totals[c.key]))).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * Totals row: sums every column marked `total` (exact bigint for money). The
 * first text column gets the label "Total".
 */
export function computeTotals(columns: readonly ReportColumn[], rows: readonly ReportRow[]): ReportRow | null {
  const summed = columns.filter((c) => c.total);
  if (summed.length === 0) return null;
  const out: ReportRow = {};
  for (const c of summed) {
    if (c.type === "money") out[c.key] = rows.reduce((s, r) => s + asBigint(r[c.key]), ZERO);
    else out[c.key] = rows.reduce((s, r) => s + Number(r[c.key] ?? 0), 0);
  }
  const labelCol = columns.find((c) => c.type === "text" && !c.total);
  if (labelCol) out[labelCol.key] = "Total";
  return out;
}

/** Excel cell value: money as a number of pesos (via the exact decimal string), pct as a fraction. */
export function excelCell(type: ColumnType, v: ReportValue): string | number | Date | null {
  if (v === null || v === undefined || v === "") return null;
  switch (type) {
    case "money":
      return Number(toDecimalString(asBigint(v)));
    case "int":
      return Number(v);
    case "pct":
      return Number(v) / 10000;
    case "date": {
      const s = String(v);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : s;
    }
    default:
      return String(v);
  }
}

export const EXCEL_FORMATS: Record<ColumnType, string | undefined> = {
  money: "#,##0.00",
  int: "#,##0",
  pct: "0.0%",
  date: "yyyy-mm-dd",
  text: undefined,
};

import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import ExcelJS from "exceljs";
import { EXCEL_FORMATS, excelCell, isNumeric, pdfCell, toCsv, type ReportColumn, type ReportRow } from "@/lib/reports/format";

export type ReportDoc = {
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  notes: string[];
  landscape?: boolean;
  generatedAt: string;
};

export function reportCsv(d: ReportDoc): Buffer {
  // BOM so Excel opens UTF-8 (₱, ñ) correctly.
  return Buffer.from(`﻿${toCsv(d.columns, d.rows, d.totals)}`, "utf8");
}

/** Excel: numbers stay numbers (pesos with 2 decimals); totals are the exact bigint sums, not Excel formulas. */
export async function reportXlsx(d: ReportDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // Sheet names: at most 31 characters and none of * ? : \ / [ ]
  const ws = wb.addWorksheet(d.title.replace(/[*?:\\/[\]]/g, "-").slice(0, 31));
  ws.addRow([d.title]).font = { bold: true, size: 13 };
  ws.addRow([d.subtitle]);
  ws.addRow([]);
  ws.addRow(d.columns.map((c) => c.label)).font = { bold: true };
  for (const r of d.rows) ws.addRow(d.columns.map((c) => excelCell(c.type, r[c.key])));
  if (d.totals) ws.addRow(d.columns.map((c) => (c.type === "text" ? (d.totals?.[c.key] ?? null) : excelCell(c.type, d.totals?.[c.key])))).font = { bold: true };
  if (d.notes.length) {
    ws.addRow([]);
    for (const n of d.notes) ws.addRow([n]).font = { italic: true, color: { argb: "FF666666" } };
  }
  d.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.type === "text" ? 28 : c.type === "date" ? 12 : 16;
    const fmt = EXCEL_FORMATS[c.type];
    if (fmt) col.numFmt = fmt;
  });
  ws.views = [{ state: "frozen", ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const s = StyleSheet.create({
  page: { padding: 28, fontSize: 8, fontFamily: "Helvetica", color: "#111" },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  muted: { color: "#666", marginTop: 2 },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333", paddingVertical: 3, fontFamily: "Helvetica-Bold", marginTop: 10 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#ddd", paddingVertical: 2 },
  total: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#333", paddingVertical: 3, fontFamily: "Helvetica-Bold" },
  footer: { position: "absolute", bottom: 14, left: 28, right: 28, flexDirection: "row", justifyContent: "space-between", color: "#888" },
});

/** Generic PDF table. Money prints as "PHP" (the built-in fonts have no ₱). */
export async function reportPdf(d: ReportDoc): Promise<Buffer> {
  const weight = (c: ReportColumn) => (c.type === "text" ? 2.2 : c.type === "date" ? 1.1 : 1.3);
  // Fixed percentage widths (not flex) and no per-row wrap checks: layout is several times faster on long tables.
  const totalWeight = d.columns.reduce((t, c) => t + weight(c), 0);
  const styles = new Map(
    d.columns.map((c) => [c.key, { width: `${((weight(c) / totalWeight) * 100).toFixed(2)}%`, paddingRight: 4, textAlign: isNumeric(c.type) ? ("right" as const) : ("left" as const) }]),
  );
  const cell = (c: ReportColumn) => styles.get(c.key)!;
  // Explicit pages: react-pdf's automatic page splitting is quadratic on long tables
  // (2,000 rows took over a minute); fixed chunks keep it linear.
  const landscape = d.landscape || d.columns.length > 7;
  const perPage = landscape ? 30 : 48;
  const chunks: ReportRow[][] = [];
  for (let i = 0; i < d.rows.length; i += perPage) chunks.push(d.rows.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  const last = chunks.length - 1;
  const doc = (
    <Document title={d.title}>
      {chunks.map((rows, p) => (
        <Page key={p} size="A4" orientation={landscape ? "landscape" : "portrait"} style={s.page}>
          {p === 0 ? <Text style={s.h1}>{d.title}</Text> : null}
          {p === 0 ? <Text style={s.muted}>{d.subtitle}</Text> : null}
          <View style={s.head}>
            {d.columns.map((c) => <Text key={c.key} style={cell(c)}>{c.label}</Text>)}
          </View>
          {rows.map((r, i) => (
            <View key={i} style={s.row}>
              {d.columns.map((c) => <Text key={c.key} style={cell(c)}>{pdfCell(c.type, r[c.key])}</Text>)}
            </View>
          ))}
          {d.rows.length === 0 ? <Text style={s.muted}>No rows for this period.</Text> : null}
          {p === last && d.totals ? (
            <View style={s.total}>
              {d.columns.map((c) => <Text key={c.key} style={cell(c)}>{c.type === "text" ? String(d.totals?.[c.key] ?? "") : pdfCell(c.type, d.totals?.[c.key])}</Text>)}
            </View>
          ) : null}
          {p === last ? d.notes.map((n) => <Text key={n} style={[s.muted, { marginTop: 6 }]}>{n}</Text>) : null}
          <View style={s.footer} fixed>
            <Text>{d.title} · generated {d.generatedAt}</Text>
            <Text>Page {p + 1} of {chunks.length}</Text>
          </View>
        </Page>
      ))}
    </Document>
  );
  return renderToBuffer(doc);
}

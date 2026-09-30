import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { toDecimalString, type Centavos } from "@/lib/money";

/** Pesos as a plain number for charts only (display; the exact centavos stay on the server). */
export const chartPesos = (c: Centavos): number => Number(toDecimalString(c));

export function Section({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Stat tile: label, value (the one loud thing), optional context line. */
export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold leading-tight">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function Loading({ title }: { title: string }) {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <CardTitle className="text-muted-foreground">{title}</CardTitle>
        <CardDescription>Loading…</CardDescription>
      </CardHeader>
    </Card>
  );
}

/** "Show data" table under a chart: the accessible, hover-free view of the same numbers. */
export function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground underline">Show data</summary>
      <Table>
        <thead>
          <tr>{columns.map((c, i) => <Th key={c} className={i > 0 ? "text-right" : ""}>{c}</Th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((v, j) => <Td key={j} className={j > 0 ? "text-right" : ""}>{v}</Td>)}</tr>
          ))}
        </tbody>
      </Table>
    </details>
  );
}

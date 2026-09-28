import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { PrintButton } from "@/components/print-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireStaff } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { formatCell, isNumeric } from "@/lib/reports/format";
import { cn } from "@/lib/utils";
import { findReport } from "@/server/reports/registry";
import { runReport } from "@/server/reports/run";
import { resolveContext } from "@/server/reports/types";

const MAX_ROWS_ON_SCREEN = 2000;

export async function generateMetadata({ params }: PageProps<"/app/reports/[key]">) {
  const { key } = await params;
  return { title: findReport(key)?.title ?? "Report" };
}

export default async function ReportPage({ params, searchParams }: PageProps<"/app/reports/[key]">) {
  const { key } = await params;
  const def = findReport(key);
  if (!def) notFound();
  const session = await requireStaff();
  if (!hasAnyRole(session.roles, def.roles)) redirect("/forbidden");
  const sp = await searchParams;
  const { ctx, options, doc } = await withUserTx(session.claims, async (tx) => {
    const r = await resolveContext(tx, def, sp, { today: businessToday(), userId: session.userId, roles: session.roles });
    return { ...r, doc: await runReport(tx, def, r.ctx) };
  });
  const query = new URLSearchParams({ from: ctx.from, to: ctx.to, ...ctx.params });
  const exportHref = (format: string) => `/app/reports/${def.key}/export?${query.toString()}&format=${format}`;
  const shown = doc.rows.slice(0, MAX_ROWS_ON_SCREEN);

  return (
    <>
      <PageHeader
        title={def.title}
        description={def.description}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button asChild variant="outline"><a href={exportHref("xlsx")}>Excel</a></Button>
            <Button asChild variant="outline"><a href={exportHref("pdf")} target="_blank">PDF</a></Button>
            <Button asChild variant="ghost"><a href={exportHref("csv")}>CSV</a></Button>
            <PrintButton />
          </div>
        }
      />
      <form className="mb-4 flex flex-wrap items-end gap-3 rounded-md border p-3 print:hidden">
        {def.rangeKind === "as_of" ? (
          <Field label="As of" htmlFor="to"><Input id="to" name="to" type="date" defaultValue={ctx.to} className="w-44" /></Field>
        ) : (
          <>
            <Field label="From" htmlFor="from"><Input id="from" name="from" type="date" defaultValue={ctx.from} className="w-44" /></Field>
            <Field label="To" htmlFor="to"><Input id="to" name="to" type="date" defaultValue={ctx.to} className="w-44" /></Field>
          </>
        )}
        {(def.params ?? []).map((p) => (
          <Field key={p.key} label={p.label} htmlFor={`p-${p.key}`}>
            <Select id={`p-${p.key}`} name={p.key} defaultValue={ctx.params[p.key]} className="min-w-44">
              {options[p.key].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
        ))}
        <Button type="submit">Show</Button>
        <Link href="/app/reports" className="ml-auto text-sm underline">All reports</Link>
      </form>
      <p className="mb-2 text-sm text-muted-foreground">{doc.subtitle} · {doc.rows.length} row(s)</p>
      <Card>
        <Table>
          <thead>
            <tr>{doc.columns.map((c) => <Th key={c.key} className={cn(isNumeric(c.type) && "text-right")}>{c.label}</Th>)}</tr>
          </thead>
          <tbody>
            {shown.length === 0 ? <tr><Td colSpan={doc.columns.length} className="text-muted-foreground">No rows for this period.</Td></tr> : null}
            {shown.map((r, i) => (
              <tr key={i}>
                {doc.columns.map((c) => (
                  <Td key={c.key} className={cn(isNumeric(c.type) && "text-right money", c.type === "date" && "whitespace-nowrap")}>{formatCell(c.type, r[c.key])}</Td>
                ))}
              </tr>
            ))}
          </tbody>
          {doc.totals ? (
            <tfoot>
              <tr className="font-semibold">
                {doc.columns.map((c) => (
                  <Td key={c.key} className={cn(isNumeric(c.type) && "text-right money")}>{c.type === "text" ? String(doc.totals?.[c.key] ?? "") : formatCell(c.type, doc.totals?.[c.key])}</Td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </Table>
      </Card>
      {doc.rows.length > MAX_ROWS_ON_SCREEN ? (
        <p className="mt-2 text-sm text-warning">Showing the first {MAX_ROWS_ON_SCREEN} rows; the totals and the exports include all {doc.rows.length}.</p>
      ) : null}
      {doc.notes.map((n) => <p key={n} className="mt-2 text-xs text-muted-foreground">{n}</p>)}
      <p className="mt-2 hidden text-xs text-muted-foreground print:block">Generated {doc.generatedAt}</p>
    </>
  );
}

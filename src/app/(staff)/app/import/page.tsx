import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { IMPORT_KIND_INFO, IMPORT_KINDS, isImportKind, templateName } from "@/lib/imports/kinds";
import { cn } from "@/lib/utils";
import { listImportBatches } from "@/server/imports/service";
import { listAgents } from "@/server/queries/staff";
import { importAction } from "./actions";
import { ImportForm } from "./import-form";

export const metadata = { title: "Import spreadsheets" };
/** Large files: the import runs in one transaction inside the server action. */
export const maxDuration = 60;

const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

/** Data migration from the old spreadsheets (owner/admin only). */
export default async function ImportPage({ searchParams }: PageProps<"/app/import">) {
  const session = await requireRole(["owner_admin"]);
  const { kind: kindParam } = await searchParams;
  const kind = typeof kindParam === "string" && isImportKind(kindParam) ? kindParam : null;
  const today = businessToday();
  const { batches, agents } = await withUserTx(session.claims, async (tx) => ({
    batches: await listImportBatches(tx),
    agents: kind === "leads" ? await listAgents(tx) : undefined,
  }));
  const done = new Set(batches.map((b) => b.kind));
  const info = kind ? IMPORT_KIND_INFO[kind] : null;

  return (
    <>
      <PageHeader
        title="Import spreadsheets"
        description="Bring the old sheets in, one kind at a time and in this order. Each file is checked row by row first; nothing is saved unless every row is valid."
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <nav aria-label="Import steps">
          <ol className="flex flex-col gap-1">
            {IMPORT_KINDS.map((k, i) => (
              <li key={k}>
                <Link
                  href={`/app/import?kind=${k}`}
                  className={cn("flex items-start gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted", k === kind && "bg-muted font-medium")}
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs">{i + 1}</span>
                  <span className="flex-1">
                    {IMPORT_KIND_INFO[k].label}
                    <span className="block text-xs font-normal text-muted-foreground">{IMPORT_KIND_INFO[k].summary}</span>
                  </span>
                  {done.has(k) ? <Badge variant="success">done</Badge> : null}
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          {kind && info ? (
            <Card>
              <CardHeader>
                <CardTitle>{info.label}</CardTitle>
                <CardDescription>
                  Template:{" "}
                  <a href={`/templates/${templateName(kind)}.xlsx`} className="underline" download>
                    Excel
                  </a>{" "}
                  ·{" "}
                  <a href={`/templates/${templateName(kind)}.csv`} className="underline" download>
                    CSV
                  </a>
                  {kind === "leads" ? (
                    <>
                      {" "}
                      · Day-to-day lead lists: <Link href="/app/crm/import" className="underline">Leads (CRM) → Import</Link>
                    </>
                  ) : null}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {info.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">Columns</summary>
                  <Table className="mt-2 text-xs">
                    <thead>
                      <tr>
                        <Th>Column</Th>
                        <Th>Also accepted</Th>
                        <Th>What to put</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.columns.map((c) => (
                        <tr key={c.key}>
                          <Td className="font-mono">
                            {c.key}
                            {c.required ? <span className="text-destructive"> *</span> : null}
                          </Td>
                          <Td className="text-muted-foreground">{(c.aliases ?? []).join(", ")}</Td>
                          <Td>{c.hint}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </details>
                <ImportForm key={kind} action={importAction} kind={kind} dateParam={info.dateParam} defaultDate={today} agents={agents} />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-4 text-sm sm:pt-5">
                <p>Choose a step on the left. Suggested go-live routine:</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>Freeze the old sheets at the end of the cut-off day.</li>
                  <li>Import vehicles and drivers, then boundary plans starting on go-live day and the RTO contracts.</li>
                  <li>Import the opening balances as of the cut-off day, then the old payments (reference only).</li>
                  <li>Employees, investors and leads can follow any time.</li>
                  <li>Check a few drivers&apos; balances against the sheets before collecting.</li>
                </ol>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Import history</CardTitle>
              <CardDescription>Every committed file. A file can be imported only once per kind.</CardDescription>
            </CardHeader>
            {batches.length === 0 ? (
              <CardContent className="text-sm text-muted-foreground">Nothing imported yet.</CardContent>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Kind</Th>
                    <Th>File</Th>
                    <Th className="text-right">Rows</Th>
                    <Th>Result</Th>
                    <Th>By</Th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <Td className="whitespace-nowrap">{TIME.format(new Date(b.created_at))}</Td>
                      <Td>{isImportKind(b.kind) ? IMPORT_KIND_INFO[b.kind].label : b.kind}</Td>
                      <Td className="break-all">
                        {b.file_name}
                        {b.as_of ? <div className="text-xs text-muted-foreground">as of {b.as_of}</div> : null}
                      </Td>
                      <Td className="text-right">{b.row_count}</Td>
                      <Td className="text-xs">
                        {b.summary.counts ? `${b.summary.counts.ready} saved, ${b.summary.counts.skipped} skipped` : ""}
                        {(b.summary.totals ?? []).map((t) => (
                          <div key={t.label} className="text-muted-foreground">
                            {t.label}: <span className="money">{t.value}</span>
                          </div>
                        ))}
                      </Td>
                      <Td>{b.created_by_name ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

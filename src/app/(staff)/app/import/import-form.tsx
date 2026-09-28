"use client";

import { useActionState } from "react";
import { Field } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { ImportState } from "./actions";

const ACTION_LABEL: Record<string, string> = { create: "New", skip: "Skip", post: "Post", store: "Store", link: "Link" };
const STATUS_VARIANT = { ok: "success", warn: "warning", skip: "muted", error: "destructive" } as const;

/** Upload → preview (every row checked) → import. The file is sent again on Import. */
export function ImportForm({
  action,
  kind,
  dateParam,
  defaultDate,
  agents,
}: {
  action: (s: ImportState, f: FormData) => Promise<ImportState>;
  kind: string;
  dateParam?: "asOf" | "startDate";
  defaultDate: string;
  agents?: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const r = state.result;
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={kind} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Spreadsheet (.xlsx first sheet, or .csv)" htmlFor="file">
          <Input id="file" name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
        </Field>
        {dateParam === "asOf" ? (
          <Field label="Balances as of" htmlFor="date" hint="Usually the day before go-live or go-live day. Not in the future.">
            <Input id="date" name="date" type="date" defaultValue={defaultDate} max={defaultDate} required />
          </Field>
        ) : null}
        {dateParam === "startDate" ? (
          <Field label="Plans start on (when the file has no start date)" htmlFor="date" hint="Go-live day: today or later.">
            <Input id="date" name="date" type="date" defaultValue={defaultDate} min={defaultDate} required />
          </Field>
        ) : null}
        {agents ? (
          <Field label="Assign new leads to" htmlFor="assignTo">
            <Select id="assignTo" name="assignTo" defaultValue="">
              <option value="">Nobody (assign later)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="preview" variant="outline" disabled={pending}>
          {pending ? "Checking…" : "Preview"}
        </Button>
        <Button type="submit" name="intent" value="import" disabled={pending || !r || r.committed || r.counts.errors > 0 || !!r.problem}>
          Import
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Preview first. Import stays disabled until a preview shows no errors; nothing is saved unless every row is valid.</p>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm text-success">
          {state.ok}
        </p>
      ) : null}
      {r && r.ignoredColumns.length ? <p className="text-xs text-muted-foreground">Ignored columns: {r.ignoredColumns.join(", ")}</p> : null}
      {r && r.totals.length ? (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {r.totals.map((t) => (
            <div key={t.label} className="flex justify-between gap-3 border-b py-1">
              <dt className="text-muted-foreground">{t.label}</dt>
              <dd className="money">{t.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {r && r.rows.length ? (
        <div className="max-h-[32rem] overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1">Line</th>
                <th className="px-2 py-1">Row</th>
                <th className="px-2 py-1">Details</th>
                <th className="px-2 py-1">Result</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row) => (
                <tr key={row.line} className={row.status === "error" ? "bg-destructive/10" : ""}>
                  <td className="px-2 py-1 align-top">{row.line}</td>
                  <td className="px-2 py-1 align-top font-medium">{row.label}</td>
                  <td className="px-2 py-1 align-top">{row.detail}</td>
                  <td className="px-2 py-1 align-top">
                    <Badge variant={STATUS_VARIANT[row.status]}>{row.action ? ACTION_LABEL[row.action] : "Error"}</Badge>{" "}
                    <span className={row.status === "error" ? "text-destructive" : ""}>{row.note}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </form>
  );
}

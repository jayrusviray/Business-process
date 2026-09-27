"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImportState } from "./actions";

/** CSV upload with a dry-run preview before anything is saved. */
export function CsvImport({
  action,
  ruleId,
  periodDate,
}: {
  action: (s: ImportState, f: FormData) => Promise<ImportState>;
  ruleId: string;
  periodDate: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="periodDate" value={periodDate} />
      <p className="text-xs text-muted-foreground">
        Columns: a driver column (<code>mobile</code>, <code>plate</code> or <code>driver_id</code>) and a value column (<code>trips</code>,{" "}
        <code>rides</code> or <code>value</code>). Any source works: a platform export or your own sheet saved as CSV.
      </p>
      <Input type="file" name="file" accept=".csv,text/csv" required />
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="preview" variant="outline" disabled={pending}>
          Preview
        </Button>
        <Button type="submit" name="intent" value="import" disabled={pending}>
          Import
        </Button>
      </div>
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? <p role="status" className="text-sm">{state.ok}</p> : null}
      {state.preview?.length ? (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1">Line</th>
                <th className="px-2 py-1">In file</th>
                <th className="px-2 py-1">Driver</th>
                <th className="px-2 py-1 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {state.preview.map((r) => (
                <tr key={r.line} className={r.error ? "bg-destructive/10" : ""}>
                  <td className="px-2 py-1">{r.line}</td>
                  <td className="px-2 py-1">{r.identifier}</td>
                  <td className="px-2 py-1">{r.error ? <span className="text-destructive">{r.error}</span> : r.driverName}</td>
                  <td className="px-2 py-1 text-right">{r.value ?? r.rawValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </form>
  );
}

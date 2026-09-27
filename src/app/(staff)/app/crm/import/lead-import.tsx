"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { LeadImportState } from "../actions";

/** CSV upload with a dry-run preview before anything is saved. */
export function LeadImport({
  action,
  agents,
}: {
  action: (s: LeadImportState, f: FormData) => Promise<LeadImportState>;
  agents: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Input type="file" name="file" accept=".csv,text/csv" required />
      <label className="flex flex-col gap-1 text-sm">
        Assign new leads to
        <Select name="assignTo" defaultValue="">
          <option value="">Nobody (assign later)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="preview" variant="outline" disabled={pending}>
          Preview
        </Button>
        <Button type="submit" name="intent" value="import" disabled={pending}>
          Import
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm">
          {state.ok}
        </p>
      ) : null}
      {state.preview?.length ? (
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1">Line</th>
                <th className="px-2 py-1">Name</th>
                <th className="px-2 py-1">Mobile</th>
                <th className="px-2 py-1">Source</th>
                <th className="px-2 py-1">Interest</th>
                <th className="px-2 py-1">Result</th>
              </tr>
            </thead>
            <tbody>
              {state.preview.map((r) => (
                <tr key={r.line} className={r.error ? "bg-destructive/10" : ""}>
                  <td className="px-2 py-1">{r.line}</td>
                  <td className="px-2 py-1">{r.name}</td>
                  <td className="px-2 py-1">{r.mobile}</td>
                  <td className="px-2 py-1">{r.source}</td>
                  <td className="px-2 py-1">{r.interest}</td>
                  <td className="px-2 py-1">
                    {r.error ? <span className="text-destructive">{r.error}</span> : r.duplicateOf ? `adds to ${r.duplicateOf}` : "new lead"}
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

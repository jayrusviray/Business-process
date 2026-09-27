import { asc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { leadStages } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { saveStageAction } from "../actions";

export const metadata = { title: "CRM stages" };

const KIND_HELP = { open: "Still in progress", won: "Converted (counts as a conversion)", lost: "Lost (needs a reason)" } as const;

function StageRow({ stage, mode }: { stage?: typeof leadStages.$inferSelect; mode: "edit" | "new" }) {
  return (
    <ActionForm action={saveStageAction} className="grid items-end gap-2 sm:grid-cols-[8rem_1fr_10rem_5rem_auto_auto]">
      <input type="hidden" name="mode" value={mode} />
      {mode === "edit" ? <input type="hidden" name="key" value={stage!.key} /> : null}
      {mode === "edit" ? (
        <code className="self-center text-xs text-muted-foreground">{stage!.key}</code>
      ) : (
        <Input name="key" placeholder="key (e.g. docs_review)" required aria-label="Key" />
      )}
      <Input name="label" defaultValue={stage?.label} placeholder="Label" required aria-label="Label" />
      <Select name="kind" defaultValue={stage?.kind ?? "open"} aria-label="Kind">
        {(["open", "won", "lost"] as const).map((k) => (
          <option key={k} value={k}>
            {KIND_HELP[k]}
          </option>
        ))}
      </Select>
      <Input name="sort" type="number" defaultValue={stage?.sort ?? 50} aria-label="Order" />
      <label className="flex items-center gap-1 self-center text-sm">
        <input type="checkbox" name="active" defaultChecked={stage?.active ?? true} className="size-4" /> Active
      </label>
      <Button type="submit" variant="outline">
        {mode === "new" ? "Add" : "Save"}
      </Button>
    </ActionForm>
  );
}

/** Configurable CRM pipeline (owner/admin). Stages are never deleted, only deactivated. */
export default async function StagesPage() {
  const session = await requireRole(["owner_admin"]);
  const stages = await withUserTx(session.claims, (tx) => tx.select().from(leadStages).orderBy(asc(leadStages.sort)));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="CRM stages" description="The columns of the leads board, in order. Deactivate a stage instead of deleting it." />
      <Card>
        <CardHeader>
          <CardTitle>Stages</CardTitle>
          <CardDescription>Leads keep their stage if it is deactivated; move them first.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {stages.map((s) => (
            <StageRow key={s.key} stage={s} mode="edit" />
          ))}
          <div className="border-t pt-3">
            <StageRow mode="new" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

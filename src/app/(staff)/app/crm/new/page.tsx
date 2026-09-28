import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { listAgents } from "@/server/queries/staff";
import { createLeadAction } from "../actions";
import { LeadFields } from "../lead-fields";

export const metadata = { title: "New lead" };

export default async function NewLeadPage() {
  const session = await requireRole(["owner_admin", "operations", "sales"]);
  const agents = await withUserTx(session.claims, (tx) => listAgents(tx));
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New lead" description="For Messenger chats, calls, walk-ins and referrals. Website and Lead Ads leads arrive on their own." />
      <Card>
        <CardContent className="pt-5">
          <ActionForm action={createLeadAction} className="flex flex-col gap-4">
            <LeadFields withMessage />
            <Field label="Assign to" htmlFor="assignedTo">
              <Select id="assignedTo" name="assignedTo" defaultValue={session.userId}>
                <option value="auto">Automatically (least busy sales agent)</option>
                <option value="">Nobody yet</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.id === session.userId ? " (me)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="force" className="size-4" /> Create anyway if the mobile number is already a lead
            </label>
            <Button type="submit" size="lg">
              Save lead
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}

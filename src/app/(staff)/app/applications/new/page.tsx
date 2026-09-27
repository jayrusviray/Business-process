import { asc, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { applicationTypes, clients, vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { formatPeso } from "@/lib/money";
import { listApplicationStaff } from "@/server/queries/staff";
import { createApplicationAction } from "../actions";
import { ClientPicker } from "./client-picker";

export const metadata = { title: "New application" };

export default async function NewApplicationPage({ searchParams }: PageProps<"/app/applications/new">) {
  const session = await requireRole(["owner_admin", "operations", "sales", "documentation"]);
  const sp = await searchParams;
  const data = await withUserTx(session.claims, async (tx) => ({
    types: await tx.select().from(applicationTypes).where(eq(applicationTypes.active, true)).orderBy(asc(applicationTypes.sort)),
    clients: await tx.select({ id: clients.id, name: clients.name, mobile: clients.mobile }).from(clients).orderBy(asc(clients.name)).limit(2000),
    vehicles: await tx.select({ id: vehicles.id, plateNo: vehicles.plateNo }).from(vehicles).orderBy(asc(vehicles.plateNo)),
    staff: await listApplicationStaff(tx),
  }));
  const defaultClientId = typeof sp.client === "string" && data.clients.some((c) => c.id === sp.client) ? sp.client : undefined;
  const defaultType = typeof sp.type === "string" ? sp.type : "";
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New application" description="Opens the application with the type's document checklist and quoted fee." />
      <Card>
        <CardContent className="pt-5">
          <ActionForm action={createApplicationAction} className="flex flex-col gap-4">
            <Field label="Type" htmlFor="typeKey">
              <Select id="typeKey" name="typeKey" defaultValue={defaultType} required>
                <option value="" disabled>
                  Choose the application type
                </option>
                {data.types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                    {t.defaultFeeCentavos > BigInt(0) ? ` (fee ${formatPeso(t.defaultFeeCentavos)})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <ClientPicker clients={data.clients} defaultClientId={defaultClientId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Quoted service fee (₱)" htmlFor="quotedFee" hint="Blank = the type's default fee. 0 = no fee.">
                <Input id="quotedFee" name="quotedFee" inputMode="decimal" placeholder="Default" />
              </Field>
              <Field label="Assigned to" htmlFor="assignedTo">
                <Select id="assignedTo" name="assignedTo" defaultValue={session.userId}>
                  <option value="">Nobody yet</option>
                  {data.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Vehicle (if any)" htmlFor="vehicleId">
                <Select id="vehicleId" name="vehicleId" defaultValue="">
                  <option value="">—</option>
                  {data.vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.plateNo}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Referred by" htmlFor="referrerName" hint="For referral commissions.">
                <Input id="referrerName" name="referrerName" />
              </Field>
              <Field label="Referrer's mobile" htmlFor="referrerPhone">
                <Input id="referrerPhone" name="referrerPhone" />
              </Field>
            </div>
            <Field label="Notes" htmlFor="notes">
              <textarea id="notes" name="notes" rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm" />
            </Field>
            <Button type="submit" size="lg">
              Open application
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}

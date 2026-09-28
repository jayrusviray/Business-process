import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { applications, applicationStatuses, applicationTypes, clients, franchises, vehicles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { updateClientAction } from "../../applications/actions";

export const metadata = { title: "Client" };

export default async function ClientPage({ params }: PageProps<"/app/clients/[id]">) {
  const session = await requireRole(["owner_admin", "operations", "sales", "documentation", "finance"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withUserTx(session.claims, async (tx) => {
    const [client] = await tx.select().from(clients).where(eq(clients.id, id));
    if (!client) return null;
    const apps = await tx
      .select({ id: applications.id, appNo: applications.appNo, type: applicationTypes.label, status: applicationStatuses.label, kind: applicationStatuses.kind, createdAt: applications.createdAt })
      .from(applications)
      .innerJoin(applicationTypes, eq(applicationTypes.key, applications.typeKey))
      .innerJoin(applicationStatuses, eq(applicationStatuses.key, applications.statusKey))
      .where(eq(applications.clientId, id))
      .orderBy(desc(applications.createdAt));
    const fr = await tx
      .select({ f: franchises, plateNo: vehicles.plateNo })
      .from(franchises)
      .leftJoin(vehicles, eq(vehicles.id, franchises.vehicleId))
      .where(eq(franchises.clientId, id))
      .orderBy(desc(franchises.expiresOn));
    return { client, apps, fr };
  });
  if (!data) notFound();
  const { client, apps, fr } = data;
  const canEdit = hasAnyRole(session.roles, ["owner_admin", "operations", "sales", "documentation"]);

  return (
    <>
      <PageHeader
        title={client.name}
        description={[client.kind === "company" ? "Company" : "Person", client.mobile, client.email].filter(Boolean).join(" · ")}
        actions={
          canEdit ? (
            <Button asChild>
              <Link href={`/app/applications/new?client=${client.id}`}>New application</Link>
            </Button>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Applications</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {apps.length === 0 ? <li className="py-2 text-muted-foreground">None yet.</li> : null}
                {apps.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <Link href={`/app/applications/${a.id}`} className="font-mono text-xs underline">
                        {a.appNo}
                      </Link>{" "}
                      {a.type}
                    </span>
                    <Badge variant={a.kind === "approved" || a.kind === "completed" ? "success" : a.kind === "cancelled" ? "muted" : "default"}>{a.status}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Franchises</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {fr.length === 0 ? <li className="py-2 text-muted-foreground">No franchises linked. Link them on the vehicle page.</li> : null}
                {fr.map(({ f, plateNo }) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {f.kind} {f.number}
                      {plateNo ? ` · ${plateNo}` : ""}
                    </span>
                    <span className="text-muted-foreground">{f.expiresOn ? `expires ${f.expiresOn}` : "no expiry"}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {client.leadId ? (
            <Link href={`/app/crm/${client.leadId}`} className="text-sm underline">
              Original CRM lead
            </Link>
          ) : null}
          {client.driverId ? (
            <Link href={`/app/drivers/${client.driverId}`} className="text-sm underline">
              Driver profile
            </Link>
          ) : null}
        </div>
        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm action={updateClientAction} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="clientId" value={client.id} />
                <Field label="Name" htmlFor="name">
                  <Input id="name" name="name" defaultValue={client.name} required />
                </Field>
                <Field label="Type" htmlFor="kind">
                  <Select id="kind" name="kind" defaultValue={client.kind}>
                    <option value="person">Person</option>
                    <option value="company">Company</option>
                  </Select>
                </Field>
                <Field label="Mobile" htmlFor="mobile">
                  <Input id="mobile" name="mobile" type="tel" defaultValue={client.mobile} />
                </Field>
                <Field label="Email" htmlFor="email">
                  <Input id="email" name="email" type="email" defaultValue={client.email ?? ""} />
                </Field>
                <Field label="Contact person" htmlFor="contactPerson">
                  <Input id="contactPerson" name="contactPerson" defaultValue={client.contactPerson} />
                </Field>
                <Field label="TIN" htmlFor="tin">
                  <Input id="tin" name="tin" defaultValue={client.tin} />
                </Field>
                <Field label="Address" htmlFor="address" className="sm:col-span-2">
                  <Input id="address" name="address" defaultValue={client.address} />
                </Field>
                <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
                  <textarea id="notes" name="notes" rows={3} defaultValue={client.notes} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm" />
                </Field>
                <Button type="submit" className="sm:col-span-2">
                  Save
                </Button>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

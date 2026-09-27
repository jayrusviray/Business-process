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
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { drivers, franchises, vehicleAssignments, vehicles } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { addFranchise, updateVehicle } from "../actions";
import { VehicleForm } from "../vehicle-form";

export const metadata = { title: "Vehicle" };

export default async function VehiclePage({ params }: PageProps<"/app/vehicles/[id]">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const canEdit = hasAnyRole(session.roles, ["owner_admin", "operations"]);
  const data = await withUserTx(session.claims, async (tx) => {
    const [vehicle] = await tx.select().from(vehicles).where(eq(vehicles.id, id));
    if (!vehicle) return null;
    const history = await tx
      .select({ a: vehicleAssignments, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(vehicleAssignments)
      .innerJoin(drivers, eq(drivers.id, vehicleAssignments.driverId))
      .where(eq(vehicleAssignments.vehicleId, id))
      .orderBy(desc(vehicleAssignments.startDate));
    const fr = await tx.select().from(franchises).where(eq(franchises.vehicleId, id)).orderBy(desc(franchises.expiresOn));
    return { vehicle, history, fr };
  });
  if (!data) notFound();
  const { vehicle, history, fr } = data;

  return (
    <>
      <PageHeader
        title={vehicle.plateNo}
        description={`${vehicle.make} ${vehicle.model} ${vehicle.year ?? ""}${vehicle.isEv ? " · EV" : ""} · ${vehicle.fundingSource}`}
        actions={<Badge className="self-center">{vehicle.status}</Badge>}
      />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Assignment history</CardTitle>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <Th>Driver</Th>
                <Th>From</Th>
                <Th>To</Th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <Td colSpan={3} className="text-muted-foreground">
                    Never assigned. Assign from the driver&apos;s page.
                  </Td>
                </tr>
              ) : null}
              {history.map(({ a, firstName, lastName }) => (
                <tr key={a.id}>
                  <Td>
                    <Link href={`/app/drivers/${a.driverId}`} className="underline">
                      {lastName}, {firstName}
                    </Link>
                  </Td>
                  <Td>{a.startDate}</Td>
                  <Td>{a.endDate ?? <Badge variant="success">current</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Franchise (PA / CPC)</CardTitle>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Number</Th>
                <Th>Operator</Th>
                <Th>Expires</Th>
              </tr>
            </thead>
            <tbody>
              {fr.map((f) => (
                <tr key={f.id}>
                  <Td>{f.kind}</Td>
                  <Td>{f.number}</Td>
                  <Td>{f.operatorName}</Td>
                  <Td>{f.expiresOn ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {canEdit ? (
            <CardContent className="pt-4">
              <ActionForm action={addFranchise} className="grid gap-2 sm:grid-cols-3">
                <input type="hidden" name="vehicleId" value={vehicle.id} />
                <Field label="Type" htmlFor="kind">
                  <Select id="kind" name="kind">
                    <option value="PA">PA</option>
                    <option value="CPC">CPC</option>
                  </Select>
                </Field>
                <Field label="Number" htmlFor="number">
                  <Input id="number" name="number" required />
                </Field>
                <Field label="Operator" htmlFor="operatorName">
                  <Input id="operatorName" name="operatorName" required />
                </Field>
                <Field label="Issued" htmlFor="issuedOn">
                  <Input id="issuedOn" name="issuedOn" type="date" />
                </Field>
                <Field label="Expires" htmlFor="expiresOn">
                  <Input id="expiresOn" name="expiresOn" type="date" />
                </Field>
                <Button type="submit" variant="outline" size="sm" className="self-end">
                  Add franchise
                </Button>
              </ActionForm>
            </CardContent>
          ) : null}
        </Card>
      </div>
      {canEdit ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Edit vehicle</summary>
          <Card className="mt-3">
            <CardContent className="pt-4 sm:pt-5">
              <VehicleForm action={updateVehicle} vehicle={vehicle} submitLabel="Save changes" />
            </CardContent>
          </Card>
        </details>
      ) : null}
    </>
  );
}

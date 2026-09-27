import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { createVehicle } from "../actions";
import { VehicleForm } from "../vehicle-form";

export const metadata = { title: "New vehicle" };

export default async function NewVehiclePage() {
  await requireRole(["owner_admin", "operations"]);
  return (
    <>
      <PageHeader title="New vehicle" />
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <VehicleForm action={createVehicle} submitLabel="Create vehicle" />
        </CardContent>
      </Card>
    </>
  );
}

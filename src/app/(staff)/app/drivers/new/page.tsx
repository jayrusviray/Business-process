import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { createDriver } from "../actions";
import { DriverForm } from "../driver-form";

export const metadata = { title: "New driver" };

export default async function NewDriverPage() {
  await requireRole(["owner_admin", "finance", "operations"]);
  return (
    <>
      <PageHeader title="New driver" description="After saving, set the boundary plan and assign a vehicle." />
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <DriverForm action={createDriver} submitLabel="Create driver" />
        </CardContent>
      </Card>
    </>
  );
}

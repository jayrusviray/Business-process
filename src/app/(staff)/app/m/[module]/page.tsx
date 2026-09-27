import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireStaff } from "@/lib/auth/session";
import { hasAnyRole } from "@/lib/auth/roles";
import { findModule } from "@/lib/nav";

/** Placeholder for modules delivered in later phases. Replaced by real routes as they ship. */
export default async function ModulePlaceholder({ params }: PageProps<"/app/m/[module]">) {
  const { module } = await params;
  const item = findModule(module);
  if (!item) notFound();
  const session = await requireStaff();
  if (!hasAnyRole(session.roles, item.roles)) redirect("/forbidden");
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground sm:pt-5">
          This module is scheduled for Phase {item.phase} of the build plan.
        </CardContent>
      </Card>
    </>
  );
}

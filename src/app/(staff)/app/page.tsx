import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaff } from "@/lib/auth/session";
import { navForRoles } from "@/lib/nav";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireStaff();
  const modules = navForRoles(session.roles)
    .flatMap((s) => s.items)
    .filter((i) => i.href !== "/app");
  return (
    <>
      <PageHeader
        title={`Welcome${session.profile.fullName ? `, ${session.profile.fullName}` : ""}`}
        description="The business performance dashboard (collections, aging, activations) arrives in Phase 8."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((m) => (
          <Link key={m.href} href={m.href} className="block">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{m.label}</CardTitle>
                  {m.phase > 1 ? <Badge variant="muted">Phase {m.phase}</Badge> : <Badge variant="success">Ready</Badge>}
                </div>
                {m.description ? <CardDescription>{m.description}</CardDescription> : null}
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

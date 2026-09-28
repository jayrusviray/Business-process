import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaff } from "@/lib/auth/session";
import { reportsForRoles } from "@/server/reports/registry";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  const session = await requireStaff();
  const list = reportsForRoles(session.roles);
  const groups = [...new Set(list.map((r) => r.group))];
  return (
    <>
      <PageHeader title="Reports" description="Every report has a date filter, an on-screen table, Excel, PDF and CSV exports, and prints cleanly." />
      {list.length === 0 ? <p className="text-sm text-muted-foreground">No reports for your role.</p> : null}
      {groups.map((g) => (
        <section key={g} className="mb-6">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">{g}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list
              .filter((r) => r.group === g)
              .map((r) => (
                <Link key={r.key} href={`/app/reports/${r.key}`} className="block">
                  <Card className="h-full transition-colors hover:bg-muted/50">
                    <CardHeader>
                      <CardTitle>{r.title}</CardTitle>
                      <CardDescription>{r.description}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

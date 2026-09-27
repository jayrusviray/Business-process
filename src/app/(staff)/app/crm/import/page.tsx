import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { listAgents } from "@/server/queries/staff";
import { importLeadsAction } from "../actions";
import { LeadImport } from "./lead-import";

export const metadata = { title: "Import leads" };

export default async function ImportLeadsPage() {
  const session = await requireRole(["owner_admin", "operations", "sales"]);
  const agents = await withUserTx(session.claims, (tx) => listAgents(tx));
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Import leads" description="From a spreadsheet saved as CSV (e.g. a Facebook leads export or your old lead list)." />
      <Card>
        <CardHeader>
          <CardTitle>CSV file</CardTitle>
          <CardDescription>
            Columns: <code>name</code> (required), <code>mobile</code>, <code>email</code>, <code>facebook</code>, <code>source</code>,{" "}
            <code>interest</code>, <code>location</code>, <code>notes</code>. Each row needs a mobile, email or Facebook name. A row whose
            mobile matches an open lead is added to that lead&apos;s timeline instead of creating a duplicate.{" "}
            <a href="/templates/leads.csv" className="underline" download>
              Download template
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LeadImport action={importLeadsAction} agents={agents} />
        </CardContent>
      </Card>
    </div>
  );
}

import { sql } from "drizzle-orm";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";

export const metadata = { title: "Clients" };

type Row = { id: string; name: string; kind: string; mobile: string; email: string | null; open_apps: number; total_apps: number };

/** Operators, drivers and companies TransRev files applications for. */
export default async function ClientsPage({ searchParams }: PageProps<"/app/clients">) {
  const session = await requireRole(["owner_admin", "operations", "sales", "documentation", "finance"]);
  const { q: qp } = await searchParams;
  const q = typeof qp === "string" ? qp.trim() : "";
  const digits = q.replace(/[^\d]/g, "");
  const rows = await withUserTx(session.claims, (tx) =>
    tx.execute<Row>(sql`
      SELECT c.id, c.name, c.kind, c.mobile, c.email,
        (SELECT count(*)::int FROM public.applications a JOIN public.application_statuses s ON s.key = a.status_key
          WHERE a.client_id = c.id AND s.kind IN ('open', 'on_hold', 'approved')) AS open_apps,
        (SELECT count(*)::int FROM public.applications a WHERE a.client_id = c.id) AS total_apps
      FROM public.clients c
      WHERE ${q} = '' OR c.name ILIKE '%' || ${q} || '%' OR (${digits} <> '' AND length(${digits}) >= 4 AND c.mobile LIKE '%' || ${digits} || '%')
      ORDER BY c.name LIMIT 300`),
  );
  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          <Button asChild>
            <Link href="/app/applications/new">New application</Link>
          </Button>
        }
      />
      <form className="mb-4 flex gap-2">
        <Input name="q" defaultValue={q} placeholder="Search name or mobile" className="w-64" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Mobile</Th>
              <Th>Email</Th>
              <Th className="text-right">Open</Th>
              <Th className="text-right">All</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={5} className="text-center text-muted-foreground">
                  No clients yet.
                </Td>
              </tr>
            ) : null}
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link href={`/app/clients/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                    {c.name}
                  </Link>
                  {c.kind === "company" ? <span className="ml-1 text-xs text-muted-foreground">(company)</span> : null}
                </Td>
                <Td>{c.mobile || "—"}</Td>
                <Td>{c.email ?? "—"}</Td>
                <Td className="text-right">{c.open_apps}</Td>
                <Td className="text-right">{c.total_apps}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

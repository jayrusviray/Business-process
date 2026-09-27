import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { auditLog, profiles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";

export const metadata = { title: "Audit log" };

const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "medium" });

export default async function AuditPage({ searchParams }: PageProps<"/app/admin/audit">) {
  const session = await requireRole(["owner_admin", "finance"]);
  const { table } = await searchParams;
  const tableFilter = typeof table === "string" && /^[a-z_]+$/.test(table) ? table : undefined;

  const rows = await withUserTx(session.claims, (tx) =>
    tx
      .select({
        id: auditLog.id,
        tableName: auditLog.tableName,
        rowPk: auditLog.rowPk,
        action: auditLog.action,
        actorName: profiles.fullName,
        actorLabel: auditLog.actorLabel,
        occurredAt: auditLog.occurredAt,
        changedFields: auditLog.changedFields,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .leftJoin(profiles, eq(profiles.id, auditLog.actorId))
      .where(tableFilter ? eq(auditLog.tableName, tableFilter) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(200),
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every create/update on audited records: who, when, and before/after. Entries can never be edited or deleted."
        actions={
          tableFilter ? (
            <Link href="/app/admin/audit" className="text-sm underline">
              Clear filter ({tableFilter})
            </Link>
          ) : undefined
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>When (PHT)</Th>
              <Th>Who</Th>
              <Th>Record</Th>
              <Th>Change</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <Td className="whitespace-nowrap">{TIME.format(r.occurredAt)}</Td>
                <Td>{r.actorName || r.actorLabel || "system"}</Td>
                <Td>
                  <Link href={`/app/admin/audit?table=${r.tableName}`} className="font-mono text-xs underline">
                    {r.tableName}
                  </Link>
                  <div className="font-mono text-[11px] text-muted-foreground">{r.rowPk}</div>
                </Td>
                <Td>
                  <Badge variant={r.action === "DELETE" ? "destructive" : r.action === "INSERT" ? "success" : "default"}>
                    {r.action}
                  </Badge>
                  {r.changedFields?.length ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs">{r.changedFields.join(", ")}</summary>
                      <ul className="mt-1 space-y-1 font-mono text-[11px]">
                        {r.changedFields.map((f) => (
                          <li key={f}>
                            {f}: {JSON.stringify((r.before as Record<string, unknown> | null)?.[f])} →{" "}
                            {JSON.stringify((r.after as Record<string, unknown> | null)?.[f])}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

import { asc } from "drizzle-orm";
import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { applicationStatuses, applicationTypes } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { expiryLevel } from "@/lib/applications";
import { addDays, businessToday, daysBetween, type IsoDate } from "@/lib/dates";
import { expiringDocuments, listApplications } from "@/server/queries/applications";

export const metadata = { title: "Applications" };

const KIND_VARIANT = { open: "default", approved: "success", completed: "success", on_hold: "warning", cancelled: "muted" } as const;

/** Client applications: LTFRB PA/CPC, platform activation, vehicle acquisition, driver program. */
export default async function ApplicationsPage({ searchParams }: PageProps<"/app/applications">) {
  const session = await requireRole(["owner_admin", "operations", "sales", "documentation", "finance"]);
  const sp = await searchParams;
  const view = sp.view === "closed" || sp.view === "all" ? sp.view : "open";
  const typeKey = typeof sp.type === "string" ? sp.type : "";
  const statusKey = typeof sp.status === "string" ? sp.status : "";
  const mine = sp.mine === "1";
  const q = typeof sp.q === "string" ? sp.q : "";
  const today = businessToday();
  const canCreate = hasAnyRole(session.roles, ["owner_admin", "operations", "sales", "documentation"]);
  const data = await withUserTx(session.claims, async (tx) => ({
    types: await tx.select().from(applicationTypes).orderBy(asc(applicationTypes.sort)),
    statuses: await tx.select().from(applicationStatuses).orderBy(asc(applicationStatuses.sort)),
    rows: await listApplications(tx, { view, typeKey, statusKey, mine, userId: session.userId, q }),
    expiring: await expiringDocuments(tx, today),
  }));
  const counts = new Map<string, number>();
  for (const r of data.rows) counts.set(r.status_key, (counts.get(r.status_key) ?? 0) + 1);
  const franchises = data.expiring.rows.filter((r) => r.kind === "franchise");
  const urgentBy = addDays(today, data.expiring.urgentDays);
  const warnBy = addDays(today, data.expiring.warnDays);

  return (
    <>
      <PageHeader
        title="Applications"
        description="LTFRB franchise, platform activation, vehicle acquisition and driver program applications."
        actions={
          <div className="flex flex-wrap gap-2">
            {canCreate ? (
              <Button asChild>
                <Link href="/app/applications/new">New application</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href="/app/clients">Clients</Link>
            </Button>
            {session.roles.includes("owner_admin") ? (
              <Button asChild variant="ghost">
                <Link href="/app/applications/settings">Settings</Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {franchises.length ? (
        <Card className="mb-4 border-warning">
          <CardHeader>
            <CardTitle>Franchises expiring (next {data.expiring.warnDays} days)</CardTitle>
            <CardDescription>Start the renewal early. Linked clients can be opened directly.</CardDescription>
            <ul className="text-sm">
              {franchises.map((f) => {
                const level = expiryLevel(f.expires_on, today, urgentBy, warnBy);
                return (
                  <li key={`${f.label}-${f.expires_on}`} className="flex flex-wrap items-center justify-between gap-2 py-1">
                    <span>
                      {f.label}
                      {f.plate_no ? ` · ${f.plate_no}` : ""}
                      {f.client_id ? (
                        <>
                          {" · "}
                          <Link href={`/app/clients/${f.client_id}`} className="underline">
                            {f.client_name}
                          </Link>
                        </>
                      ) : null}
                    </span>
                    <Badge variant={level === "warn" ? "warning" : "destructive"}>
                      {level === "expired" ? "expired" : "expires"} {f.expires_on}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardHeader>
        </Card>
      ) : null}

      <form className="mb-4 flex flex-wrap gap-2">
        <Select name="view" defaultValue={view} className="w-36" aria-label="Show">
          <option value="open">In progress</option>
          <option value="closed">Completed / cancelled</option>
          <option value="all">All</option>
        </Select>
        <Select name="type" defaultValue={typeKey} className="w-64" aria-label="Type">
          <option value="">All types</option>
          {data.types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={statusKey} className="w-52" aria-label="Status">
          <option value="">All statuses</option>
          {data.statuses.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="mine" value="1" defaultChecked={mine} className="size-4" /> Mine
        </label>
        <Input name="q" defaultValue={q} placeholder="Client, APP-no. or reference" className="w-56" />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      <div className="mb-3 flex flex-wrap gap-1 text-xs">
        {data.statuses
          .filter((s) => counts.has(s.key))
          .map((s) => (
            <Badge key={s.key} variant="muted">
              {s.label}: {counts.get(s.key)}
            </Badge>
          ))}
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Client</Th>
              <Th>Type</Th>
              <Th>Status</Th>
              <Th>Documents</Th>
              <Th>Assigned</Th>
              <Th className="text-right">Balance</Th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <Td colSpan={7} className="text-center text-muted-foreground">
                  No applications.
                </Td>
              </tr>
            ) : null}
            {data.rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/app/applications/${r.id}`} className="font-mono text-xs underline">
                    {r.app_no}
                  </Link>
                  {r.source === "public" ? (
                    <Badge variant="muted" className="ml-1">
                      online
                    </Badge>
                  ) : null}
                </Td>
                <Td>
                  <Link href={`/app/clients/${r.client_id}`} className="underline-offset-2 hover:underline">
                    {r.client_name}
                  </Link>
                </Td>
                <Td>{r.type_label}</Td>
                <Td>
                  <Badge variant={KIND_VARIANT[r.status_kind as keyof typeof KIND_VARIANT] ?? "default"}>{r.status_label}</Badge>
                  <div className="text-xs text-muted-foreground">{daysBetween(r.status_changed_on as IsoDate, today)}d in status</div>
                </Td>
                <Td>
                  {r.checklist_required ? (
                    <span className={r.checklist_done === r.checklist_required ? "text-success" : ""}>
                      {r.checklist_done}/{r.checklist_required}
                    </span>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{r.assigned ?? <span className="text-muted-foreground">—</span>}</Td>
                <Td className="text-right">
                  <Money value={r.balance} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

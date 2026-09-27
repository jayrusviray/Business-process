import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday, daysBetween, type IsoDate } from "@/lib/dates";
import { listDrivers } from "@/server/queries/drivers";
import { DRIVER_STATUSES, STATUS_VARIANT } from "./driver-form";

export const metadata = { title: "Drivers" };

export default async function DriversPage({ searchParams }: PageProps<"/app/drivers">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const status = typeof sp.status === "string" && (DRIVER_STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined;
  const today = businessToday();
  const rows = await withUserTx(session.claims, (tx) => listDrivers(tx, { q, status, today }));

  return (
    <>
      <PageHeader
        title="Drivers"
        description="Balances are computed live from the ledger."
        actions={
          <Button asChild>
            <Link href="/app/drivers/new">New driver</Link>
          </Button>
        }
      />
      <form className="mb-4 flex flex-col gap-2 sm:flex-row">
        <Input name="q" placeholder="Search name, phone or plate" defaultValue={q} className="sm:max-w-xs" />
        <Select name="status" defaultValue={status ?? ""} className="sm:w-40">
          <option value="">All statuses</option>
          {DRIVER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Driver</Th>
              <Th>Status</Th>
              <Th>Vehicle</Th>
              <Th className="text-right">Daily boundary</Th>
              <Th className="text-right">Balance</Th>
              <Th>Oldest unpaid</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={6} className="text-center text-muted-foreground">
                  No drivers found.
                </Td>
              </tr>
            ) : null}
            {rows.map((d) => {
              const overdueDays = d.oldest_unpaid_due ? daysBetween(d.oldest_unpaid_due as IsoDate, today) : 0;
              return (
                <tr key={d.id}>
                  <Td>
                    <Link href={`/app/drivers/${d.id}`} className="font-medium underline-offset-2 hover:underline">
                      {d.last_name}, {d.first_name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{d.phone}</div>
                  </Td>
                  <Td>
                    <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                  </Td>
                  <Td>{d.plate_no ?? <span className="text-muted-foreground">—</span>}</Td>
                  <Td className="text-right">{d.daily_rate_centavos ? <Money value={d.daily_rate_centavos} /> : "—"}</Td>
                  <Td className="text-right">
                    <Money value={d.balance_centavos} signed />
                  </Td>
                  <Td>
                    {d.oldest_unpaid_due ? (
                      <Badge variant={overdueDays > 30 ? "destructive" : overdueDays > 7 ? "warning" : "muted"}>
                        {overdueDays} day{overdueDays === 1 ? "" : "s"} ago
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">up to date</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

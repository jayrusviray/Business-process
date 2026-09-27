import { sql } from "drizzle-orm";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday, daysBetween, type IsoDate } from "@/lib/dates";

export const metadata = { title: "Vehicles" };

type Row = {
  id: string; plate_no: string; make: string; model: string; year: number | null; is_ev: boolean; status: string;
  funding_source: string; driver_id: string | null; driver_name: string | null; franchise_expires: string | null;
};

export default async function VehiclesPage() {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const today = businessToday();
  const rows = await withUserTx(session.claims, (tx) =>
    tx.execute<Row>(sql`
      SELECT v.id, v.plate_no, v.make, v.model, v.year, v.is_ev, v.status, v.funding_source,
        d.id AS driver_id, d.last_name || ', ' || d.first_name AS driver_name,
        (SELECT MIN(f.expires_on)::text FROM public.franchises f WHERE f.vehicle_id = v.id AND f.expires_on >= ${today}::date) AS franchise_expires
      FROM public.vehicles v
      LEFT JOIN public.vehicle_assignments va ON va.vehicle_id = v.id AND va.end_date IS NULL
      LEFT JOIN public.drivers d ON d.id = va.driver_id
      ORDER BY v.plate_no`),
  );
  return (
    <>
      <PageHeader
        title="Vehicles"
        actions={
          <Button asChild>
            <Link href="/app/vehicles/new">New vehicle</Link>
          </Button>
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Plate</Th>
              <Th>Vehicle</Th>
              <Th>Status</Th>
              <Th>Driver</Th>
              <Th>Funding</Th>
              <Th>Franchise expiry</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={6} className="text-center text-muted-foreground">
                  No vehicles yet.
                </Td>
              </tr>
            ) : null}
            {rows.map((v) => {
              const days = v.franchise_expires ? daysBetween(today, v.franchise_expires as IsoDate) : null;
              return (
                <tr key={v.id}>
                  <Td>
                    <Link href={`/app/vehicles/${v.id}`} className="font-medium underline-offset-2 hover:underline">
                      {v.plate_no}
                    </Link>
                  </Td>
                  <Td>
                    {v.make} {v.model} {v.year ?? ""} {v.is_ev ? <Badge variant="success">EV</Badge> : null}
                  </Td>
                  <Td>
                    <Badge variant={v.status === "available" ? "default" : v.status === "assigned" ? "success" : "muted"}>{v.status}</Badge>
                  </Td>
                  <Td>{v.driver_id ? <Link href={`/app/drivers/${v.driver_id}`} className="underline">{v.driver_name}</Link> : "—"}</Td>
                  <Td>{v.funding_source}</Td>
                  <Td>
                    {v.franchise_expires ? (
                      <Badge variant={days! <= 60 ? "warning" : "muted"}>{v.franchise_expires}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">none on file</span>
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

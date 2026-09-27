import { eq, sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { appSettings } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { addMonths, businessToday } from "@/lib/dates";
import { createContractAction } from "../actions";

export const metadata = { title: "New RTO contract" };

export default async function NewRtoPage() {
  const session = await requireRole(["owner_admin", "finance"]);
  const today = businessToday();
  const { driverRows, vehicleRows, term } = await withUserTx(session.claims, async (tx) => ({
    driverRows: await tx.execute<{ id: string; name: string; plate: string | null; vehicle_id: string | null }>(sql`
      SELECT d.id, d.last_name || ', ' || d.first_name AS name, v.plate_no AS plate, v.id AS vehicle_id
      FROM public.drivers d
      LEFT JOIN public.vehicle_assignments va ON va.driver_id = d.id AND va.end_date IS NULL
      LEFT JOIN public.vehicles v ON v.id = va.vehicle_id
      WHERE d.status IN ('active', 'applicant')
        AND NOT EXISTS (SELECT 1 FROM public.rto_contracts c WHERE c.driver_id = d.id AND c.status = 'active')
      ORDER BY name`),
    vehicleRows: await tx.execute<{ id: string; label: string }>(sql`
      SELECT v.id, v.plate_no || ' – ' || v.make || ' ' || v.model AS label FROM public.vehicles v
      WHERE v.status NOT IN ('transferred', 'retired')
        AND NOT EXISTS (SELECT 1 FROM public.rto_contracts c WHERE c.vehicle_id = v.id AND c.status = 'active')
      ORDER BY v.plate_no`),
    term: (await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "rto.default_term_months")))[0]?.value,
  }));

  return (
    <>
      <PageHeader
        title="New RTO / boundary-hulog contract"
        description="Monthly amortization is (price − down payment) ÷ term, with no interest. The last month absorbs any centavo remainder."
      />
      <Card>
        <CardContent className="pt-5">
          <ActionForm action={createContractAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Driver" htmlFor="driverId">
              <Select id="driverId" name="driverId" required>
                <option value="">Choose…</option>
                {driverRows.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.plate ? ` (${d.plate})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Vehicle" htmlFor="vehicleId">
              <Select id="vehicleId" name="vehicleId" required>
                <option value="">Choose…</option>
                {vehicleRows.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contract price" htmlFor="contractPrice">
              <Input id="contractPrice" name="contractPrice" inputMode="decimal" required />
            </Field>
            <Field label="Down payment (0 if none)" htmlFor="downPayment">
              <Input id="downPayment" name="downPayment" inputMode="decimal" defaultValue="0" />
            </Field>
            <Field label="Term (months)" htmlFor="termMonths">
              <Input id="termMonths" name="termMonths" inputMode="numeric" defaultValue={String(term ?? 60)} required />
            </Field>
            <Field label="Contract start (down payment due)" htmlFor="startDate">
              <Input id="startDate" name="startDate" type="date" defaultValue={today} required />
            </Field>
            <Field label="First amortization due" htmlFor="firstDueDate" hint="Later months fall on the same day (e.g. 31st → 30th/28th in short months).">
              <Input id="firstDueDate" name="firstDueDate" type="date" defaultValue={addMonths(today, 1)} required />
            </Field>
            <Field label="Already paid before go-live" htmlFor="paidBeforeGoLive" hint="For contracts signed before this system: the total the driver has already paid toward the vehicle.">
              <Input id="paidBeforeGoLive" name="paidBeforeGoLive" inputMode="decimal" defaultValue="0" />
            </Field>
            <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
              <Textarea id="notes" name="notes" className="font-sans" />
            </Field>
            <Button type="submit" className="justify-self-start">
              Create contract
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}

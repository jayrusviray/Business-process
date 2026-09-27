import { sql } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { addMonths, businessToday } from "@/lib/dates";
import { createLoanAction } from "../actions";

export const metadata = { title: "New vehicle loan" };

export default async function NewLoanPage() {
  const session = await requireRole(["owner_admin", "finance"]);
  const vehicleRows = await withUserTx(session.claims, (tx) =>
    tx.execute<{ id: string; label: string }>(sql`
      SELECT v.id, v.plate_no || ' – ' || v.make || ' ' || v.model AS label FROM public.vehicles v
      WHERE NOT EXISTS (SELECT 1 FROM public.vehicle_loans l WHERE l.vehicle_id = v.id AND l.status = 'active')
      ORDER BY v.plate_no`),
  );
  return (
    <>
      <PageHeader title="New vehicle loan" description="The monthly schedule (principal and interest, diminishing balance) is generated automatically. Compare it with the bank's schedule before saving." />
      <Card>
        <CardContent className="pt-5">
          <ActionForm action={createLoanAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Vehicle" htmlFor="vehicleId">
              <Select id="vehicleId" name="vehicleId" required>
                <option value="">Choose…</option>
                {vehicleRows.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </Select>
            </Field>
            <Field label="Lender" htmlFor="lender"><Input id="lender" name="lender" placeholder="e.g. BDO Auto Loan" required /></Field>
            <Field label="Loan amount" htmlFor="principal"><Input id="principal" name="principal" inputMode="decimal" required /></Field>
            <Field label="Annual interest rate (%)" htmlFor="annualRate"><Input id="annualRate" name="annualRate" inputMode="decimal" placeholder="10.5" required /></Field>
            <Field label="Term (months)" htmlFor="termMonths"><Input id="termMonths" name="termMonths" inputMode="numeric" defaultValue="36" required /></Field>
            <Field label="First due date" htmlFor="firstDueDate"><Input id="firstDueDate" name="firstDueDate" type="date" defaultValue={addMonths(businessToday(), 1)} required /></Field>
            <Field label="Notes" htmlFor="notes" className="sm:col-span-2"><Textarea id="notes" name="notes" className="font-sans" /></Field>
            <Button type="submit" className="justify-self-start">Create loan &amp; schedule</Button>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}

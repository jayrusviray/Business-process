import { asc, gte } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { holidays } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { addDays, businessToday, formatBusinessDate, type IsoDate } from "@/lib/dates";
import { addHolidayAction, removeHolidayAction } from "../../collections/actions";

export const metadata = { title: "Holidays" };

export default async function HolidaysPage() {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const isAdmin = hasAnyRole(session.roles, ["owner_admin"]);
  const today = businessToday();
  const rows = await withUserTx(session.claims, (tx) =>
    tx.select().from(holidays).where(gte(holidays.date, addDays(today, -366))).orderBy(asc(holidays.date)),
  );
  return (
    <>
      <PageHeader
        title="Holidays"
        description="Boundary is charged every day except the dates listed here. Add each year's proclaimed holidays in advance."
      />
      {isAdmin ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add holiday</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={addHolidayAction} className="flex flex-wrap items-end gap-3">
              <Field label="Date" htmlFor="date">
                <Input id="date" name="date" type="date" required />
              </Field>
              <Field label="Name" htmlFor="name">
                <Input id="name" name="name" placeholder="e.g. Rizal Day" required />
              </Field>
              <Button type="submit">Add</Button>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Holiday</Th>
              {isAdmin ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={3} className="text-muted-foreground">No holidays entered: boundary is charged every day.</Td>
              </tr>
            ) : null}
            {rows.map((h) => (
              <tr key={h.date} className={h.date < today ? "text-muted-foreground" : ""}>
                <Td>{formatBusinessDate(h.date as IsoDate)}</Td>
                <Td>{h.name}</Td>
                {isAdmin ? (
                  <Td>
                    {h.date > today ? (
                      <ActionForm action={removeHolidayAction} inlineStatus>
                        <input type="hidden" name="date" value={h.date} />
                        <Button type="submit" variant="ghost" size="sm">Remove</Button>
                      </ActionForm>
                    ) : null}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

import { eq, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { withUserTx } from "@/db/client";
import { drivers } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { listActiveDriversForPicker } from "@/server/queries/drivers";
import { listCollectors } from "@/server/queries/staff";
import { recordPaymentAction } from "../actions";
import { DriverPicker } from "../driver-picker";
import { PaymentForm } from "../payment-form";

export const metadata = { title: "Record payment" };

const LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;

export default async function RecordPaymentPage({ searchParams }: PageProps<"/app/collections/new">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const { driver: driverParam } = await searchParams;
  const driverId = typeof driverParam === "string" && /^[0-9a-f-]{36}$/i.test(driverParam) ? driverParam : null;
  const today = businessToday();

  if (!driverId) {
    const list = await withUserTx(session.claims, (tx) => listActiveDriversForPicker(tx));
    return (
      <div className="mx-auto max-w-lg">
        <PageHeader title="Record payment" description="Choose the driver." />
        <DriverPicker drivers={list} hrefBase="/app/collections/new?driver=" />
      </div>
    );
  }

  const data = await withUserTx(session.claims, async (tx) => {
    const [driver] = await tx.select().from(drivers).where(eq(drivers.id, driverId));
    if (!driver) return null;
    const accounts = await tx.execute<{ account_id: string; kind: keyof typeof LABEL; balance_centavos: string; oldest: string | null }>(sql`
      SELECT b.account_id, b.kind, b.balance_centavos::text,
        (SELECT MIN(cs.due_date)::text FROM public.v_charge_status cs WHERE cs.account_id = b.account_id AND cs.status <> 'paid') AS oldest
      FROM public.v_account_balances b WHERE b.driver_id = ${driverId} AND b.closed_on IS NULL
      ORDER BY b.kind`);
    const collectors = await listCollectors(tx);
    return { driver, accounts, collectors };
  });
  if (!data) notFound();
  const { driver, accounts, collectors } = data;

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title={`${driver.firstName} ${driver.lastName}`} description="Record payment" />
      {accounts.length === 0 ? (
        <Card>
          <CardContent className="pt-5 text-sm">
            This driver has no accounts yet. <Link href={`/app/drivers/${driver.id}`} className="underline">Start a boundary plan</Link> or post a charge first.
          </CardContent>
        </Card>
      ) : (
        <PaymentForm
          action={recordPaymentAction}
          driverId={driver.id}
          paymentId={crypto.randomUUID()}
          clientRequestId={crypto.randomUUID()}
          accounts={accounts.map((a) => ({ id: a.account_id, label: LABEL[a.kind], balance: a.balance_centavos, oldestUnpaid: a.oldest }))}
          collectors={collectors}
          defaultCollectorId={collectors.some((c) => c.id === session.userId) ? session.userId : collectors[0]?.id ?? session.userId}
          today={today}
        />
      )}
    </div>
  );
}

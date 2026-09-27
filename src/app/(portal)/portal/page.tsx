import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { BoundaryCalendar, parseMonthParam } from "@/components/boundary-calendar";
import { BonusList, DriverSummary, QuotaProgress, RtoProgressCard } from "@/components/driver-summary";
import { Money } from "@/components/money";
import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { withUserTx } from "@/db/client";
import { drivers, paymentProofs } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday, formatBusinessDate, type IsoDate } from "@/lib/dates";
import { getDriverOverview } from "@/server/queries/driver-overview";
import { ProofForm } from "./proof-form";

export const metadata = { title: "My account" };

/** Mobile-first driver portal. Everything here is read-only and limited to the driver's own rows by RLS. */
export default async function PortalPage({ searchParams }: PageProps<"/portal">) {
  const session = await requireRole(["driver", "investor"]);
  const sp = await searchParams;
  const today = businessToday();
  const month = parseMonthParam(sp.month, today);
  const o = await withUserTx(session.claims, async (tx) => {
    const [me] = await tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.profileId, session.userId));
    if (!me) return null;
    const overview = await getDriverOverview(tx, me.id, today, month);
    if (!overview) return null;
    const proofs = await tx
      .select()
      .from(paymentProofs)
      .where(eq(paymentProofs.driverId, me.id))
      .orderBy(desc(paymentProofs.submittedAt))
      .limit(5);
    return { ...overview, proofs };
  });
  const investor = !o && session.roles.includes("investor")
    ? await withUserTx(session.claims, async (tx) => ({
        vehicles: await tx.execute<{ plate_no: string; make: string; model: string }>(sql`SELECT plate_no, make, model FROM public.vehicles WHERE investor_id = app.current_investor_id() ORDER BY plate_no`),
        payouts: await tx.execute<{ id: string; month: string; plate_no: string; payable: string; status: string; paid_on: string | null }>(sql`
          SELECT p.id, p.month::text, v.plate_no, p.payable_centavos::text AS payable, p.status, p.paid_on::text
          FROM public.investor_payouts p JOIN public.vehicles v ON v.id = p.vehicle_id
          WHERE p.investor_id = app.current_investor_id() ORDER BY p.month DESC, v.plate_no LIMIT 36`),
      }))
    : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <span className="font-semibold">TransRev</span>
        <SignOutButton />
      </header>
      {investor ? (
        <>
          <h1 className="text-xl font-semibold">Hi{session.profile.fullName ? `, ${session.profile.fullName}` : ""}!</h1>
          <Card>
            <CardHeader><CardTitle>Your vehicles</CardTitle></CardHeader>
            <CardContent>
              <ul className="text-sm">
                {investor.vehicles.length === 0 ? <li className="text-muted-foreground">No vehicles linked yet.</li> : null}
                {investor.vehicles.map((v) => <li key={v.plate_no}>{v.plate_no} · {v.make} {v.model}</li>)}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Monthly share</CardTitle>
              <CardDescription>22 days of the driver&apos;s boundary less the driver&apos;s monthly RTO amortization, per vehicle.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {investor.payouts.length === 0 ? <li className="py-2 text-muted-foreground">Nothing computed yet.</li> : null}
                {investor.payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-2">
                    <span>{p.month.slice(0, 7)} · {p.plate_no}</span>
                    <span className="flex items-center gap-2">
                      <Money value={p.payable} />
                      <Badge variant={p.status === "paid" ? "success" : "muted"}>{p.status === "paid" ? `paid ${p.paid_on}` : "pending"}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      ) : !o ? (
        <Card>
          <CardHeader>
            <CardTitle>Hi{session.profile.fullName ? `, ${session.profile.fullName}` : ""}!</CardTitle>
            <CardDescription>
              {session.roles.includes("investor")
                ? "Your vehicles' revenue and payouts will appear here soon."
                : "Your login is not linked to a driver record yet. Please contact the TransRev office."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold">Hi, {o.driver.firstName}!</h1>
            <p className="text-sm text-muted-foreground">
              {o.assignment ? `${o.assignment.plateNo} · ${o.assignment.make} ${o.assignment.model}` : "No vehicle assigned"}
              {o.plan ? ` · ${o.plan.programType === "rto" ? "Boundary-hulog / RTO" : "Boundary"}` : ""}
            </p>
          </div>
          <DriverSummary o={o} today={today} />
          <Card>
            <CardHeader>
              <CardTitle>Boundary calendar</CardTitle>
            </CardHeader>
            <CardContent>
              <BoundaryCalendar
                month={month}
                charges={o.statements.find((s) => s.account.kind === "boundary")?.allocation.charges ?? []}
                holidays={o.holidaySet}
                hrefForMonth={(m: IsoDate) => `/portal?month=${m.slice(0, 7)}`}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Quota &amp; bonuses</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <QuotaProgress o={o} />
              <BonusList o={o} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>RTO progress</CardTitle>
            </CardHeader>
            <CardContent>
              <RtoProgressCard o={o} today={today} />
            </CardContent>
          </Card>
          {o.holidays.some((h) => h.date >= today) ? (
            <Card>
              <CardHeader>
                <CardTitle>Upcoming holidays (no boundary)</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm">
                  {o.holidays
                    .filter((h) => h.date >= today)
                    .slice(0, 5)
                    .map((h) => (
                      <li key={h.date}>
                        {formatBusinessDate(h.date as IsoDate)}: {h.name}
                      </li>
                    ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Paid via GCash, Maya or bank?</CardTitle>
              <CardDescription>Send us the screenshot. Your balance updates once the office verifies it.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ProofForm today={today} />
              {o.proofs.length ? (
                <ul className="divide-y text-sm">
                  {o.proofs.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {formatBusinessDate(p.paidOn as IsoDate)}
                        <span className="block text-xs text-muted-foreground">
                          {p.method.replace("_", " ")} · {p.referenceNo}
                          {p.status === "rejected" && p.rejectReason ? ` · ${p.rejectReason}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Money value={p.amountCentavos} />
                        <Badge variant={p.status === "approved" ? "success" : p.status === "rejected" ? "destructive" : "warning"}>
                          {p.status === "pending" ? "checking" : p.status}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent payments</CardTitle>
              <CardDescription>Your last 10 payments. The statement below has the full history.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {o.recentPayments.length === 0 ? <li className="py-2 text-muted-foreground">No payments yet.</li> : null}
                {o.recentPayments.slice(0, 10).map(({ p, voidReason }) => (
                  <li key={p.id} className="flex items-center justify-between py-2">
                    <span>
                      {formatBusinessDate(p.businessDate as IsoDate)}
                      <span className="block text-xs text-muted-foreground">
                        {p.receiptNo} · {p.method.replace("_", " ")}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {voidReason ? <Badge variant="destructive">void</Badge> : <Money value={p.amountCentavos} />}
                      <a href={`/portal/receipts/${p.id}`} target="_blank" className="py-2 text-xs underline" aria-label={`Receipt ${p.receiptNo}`}>
                        Receipt
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Button asChild variant="outline" size="lg">
            <Link href="/portal/statement" target="_blank">
              Download statement of account (PDF)
            </Link>
          </Button>
        </>
      )}
    </main>
  );
}

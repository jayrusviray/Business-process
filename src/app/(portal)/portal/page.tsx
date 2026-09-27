import { eq } from "drizzle-orm";
import Link from "next/link";
import { BoundaryCalendar, parseMonthParam } from "@/components/boundary-calendar";
import { BonusList, DriverSummary, QuotaProgress, RtoProgressCard } from "@/components/driver-summary";
import { Money } from "@/components/money";
import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { withUserTx } from "@/db/client";
import { drivers } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday, formatBusinessDate, type IsoDate } from "@/lib/dates";
import { getDriverOverview } from "@/server/queries/driver-overview";

export const metadata = { title: "My account" };

/** Mobile-first driver portal. Everything here is read-only and limited to the driver's own rows by RLS. */
export default async function PortalPage({ searchParams }: PageProps<"/portal">) {
  const session = await requireRole(["driver", "investor"]);
  const sp = await searchParams;
  const today = businessToday();
  const month = parseMonthParam(sp.month, today);
  const o = await withUserTx(session.claims, async (tx) => {
    const [me] = await tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.profileId, session.userId));
    return me ? getDriverOverview(tx, me.id, today, month) : null;
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <span className="font-semibold">TransRev</span>
        <SignOutButton />
      </header>
      {!o ? (
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
                    {voidReason ? <Badge variant="destructive">void</Badge> : <Money value={p.amountCentavos} />}
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

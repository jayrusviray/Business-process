import { Money } from "@/components/money";
import { ProgressBar } from "@/components/progress-bar";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { daysBetween, formatBusinessDate, type IsoDate } from "@/lib/dates";
import { formatPeso } from "@/lib/money";
import { METRIC_LABEL, progressPercent, type QuotaMetric } from "@/lib/quotas";
import type { DriverOverview } from "@/server/queries/driver-overview";

const ACCOUNT_LABEL = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" } as const;

/** The key numbers for one driver. Shared by the staff driver page and the driver portal. */
export function DriverSummary({ o, today }: { o: DriverOverview; today: IsoDate }) {
  const t = o.todayCharge;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader>
          <CardDescription>Total balance</CardDescription>
          <CardTitle className="text-2xl">
            <Money value={o.totalBalance} signed />
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {o.overdue > BigInt(0) ? (
              <>
                Overdue {formatPeso(o.overdue)}
                {o.oldestUnpaid ? ` · since ${formatBusinessDate(o.oldestUnpaid)} (${daysBetween(o.oldestUnpaid, today)} days)` : ""}
              </>
            ) : (
              "Nothing overdue"
            )}
          </p>
          {o.missedAmortizations > 0 ? (
            <Badge variant={o.missedAmortizations >= 3 ? "destructive" : "warning"}>{o.missedAmortizations} missed amortization(s)</Badge>
          ) : null}
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Today&apos;s boundary</CardDescription>
          {t ? (
            <>
              <CardTitle className="text-xl">
                <Money value={t.amount} />
              </CardTitle>
              <Badge variant={t.status === "paid" ? "success" : t.status === "partial" ? "warning" : "destructive"}>
                {t.status === "paid" ? "paid" : t.status === "partial" ? `short ${formatPeso(t.outstanding)}` : "not yet paid"}
              </Badge>
            </>
          ) : (
            <CardTitle className="text-base font-normal text-muted-foreground">
              {o.holidaySet.has(today) ? "Holiday: no boundary today" : "No boundary charged today"}
            </CardTitle>
          )}
          {o.nextDue ? (
            <p className="text-xs text-muted-foreground">
              Next: {formatPeso(o.nextDue.amount)} on {formatBusinessDate(o.nextDue.date)}
            </p>
          ) : null}
        </CardHeader>
      </Card>
      {o.statements.map((s) => (
        <Card key={s.account.id}>
          <CardHeader>
            <CardDescription>{ACCOUNT_LABEL[s.account.kind]}</CardDescription>
            <CardTitle className="text-xl">
              <Money value={s.allocation.balance} signed />
            </CardTitle>
            {s.allocation.unappliedCredit > BigInt(0) ? (
              <p className="text-xs text-success">Advance credit {formatPeso(s.allocation.unappliedCredit)}</p>
            ) : null}
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function QuotaProgress({ o }: { o: DriverOverview }) {
  if (o.quotas.length === 0) return <p className="text-sm text-muted-foreground">No active quotas.</p>;
  return (
    <ul className="flex flex-col gap-4">
      {o.quotas.map((q) => {
        const pct = progressPercent(q.value, q.rule.threshold);
        const metric = q.rule.metric as QuotaMetric;
        const fmt = (v: bigint) => (metric === "earnings_centavos" ? formatPeso(v) : v.toString());
        return (
          <li key={q.rule.id}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{q.rule.name}</span>
              <span className="text-muted-foreground">
                {fmt(q.value)} / {fmt(q.rule.threshold)} {METRIC_LABEL[metric]}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={pct >= 100 ? "h-full bg-success" : "h-full bg-primary"} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {q.period.start} – {q.period.end} · bonus {formatPeso(q.rule.bonusCentavos)}
              {q.recorded ? "" : " · no count recorded yet"}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function BonusList({ o }: { o: DriverOverview }) {
  if (o.bonuses.length === 0) return <p className="text-sm text-muted-foreground">No bonuses yet.</p>;
  return (
    <ul className="divide-y text-sm">
      {o.bonuses.map(({ b, ruleName, periodStart }) => (
        <li key={b.id} className="flex items-center justify-between gap-2 py-2">
          <span>
            {ruleName} <span className="text-xs text-muted-foreground">({periodStart.slice(0, 7)})</span>
            <span className="block text-xs text-muted-foreground">
              {b.payoutMode === "credit" ? "Credited to balance" : "Paid in cash"} on {b.paidOn}
            </span>
          </span>
          {b.voidedAt ? <Badge variant="destructive">void</Badge> : <Money value={b.amountCentavos} className="text-success" />}
        </li>
      ))}
    </ul>
  );
}

/** RTO progress: percentage paid, remaining amount, next due and projected completion. */
export function RtoProgressCard({ o, href, today }: { o: DriverOverview; href?: string; today: IsoDate }) {
  const r = o.rto;
  if (!r) return <p className="text-sm text-muted-foreground">No rent-to-own contract.</p>;
  const { contract: c, progress: p } = r;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{href ? <a href={href} className="underline">{c.contractNo}</a> : c.contractNo}</span>
        <Badge variant={c.status === "active" ? (r.missed ? "warning" : "success") : "muted"}>
          {c.status === "active" ? (r.missed ? `${r.missed} missed` : "on track") : c.status.replace("_", " ")}
        </Badge>
      </div>
      <ProgressBar percent={p.percentPaid} label="RTO paid" />
      <dl className="grid grid-cols-2 gap-y-1">
        <dt className="text-muted-foreground">Paid</dt>
        <dd className="text-right"><Money value={p.paid} /> ({p.percentPaid.toFixed(1)}%)</dd>
        <dt className="text-muted-foreground">Remaining</dt>
        <dd className="text-right"><Money value={p.remaining} /></dd>
        <dt className="text-muted-foreground">Installments</dt>
        <dd className="text-right">{p.installmentsFullyPaid} / {c.termMonths}</dd>
        {p.nextDue && c.status === "active" ? (
          <>
            <dt className="text-muted-foreground">{p.nextDue.dueDate < today ? "Overdue since" : "Next due"}</dt>
            <dd className="text-right">{formatPeso(p.nextDue.amount)} on {formatBusinessDate(p.nextDue.dueDate)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Completion</dt>
        <dd className="text-right">{formatBusinessDate(p.scheduledCompletion)}</dd>
      </dl>
    </div>
  );
}

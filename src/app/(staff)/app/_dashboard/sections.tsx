import Link from "next/link";
import { cache } from "react";
import { BarLineChart, PairedBarChart } from "@/components/charts/money-charts";
import { HBars } from "@/components/charts/hbars";
import { Money } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx, type JwtClaims } from "@/db/client";
import { expiryLevel } from "@/lib/applications";
import { collectionRateBps } from "@/lib/collections";
import { addDays, daysBetween, type IsoDate } from "@/lib/dates";
import { formatBps } from "@/lib/metrics";
import { ZERO } from "@/lib/money";
import { expiringDocuments } from "@/server/queries/applications";
import {
  applicationsSummary,
  collectorVariances,
  crmSummary,
  dailyCollectionsTrend,
  driverLabels,
  fleetCounts,
  monthlyRevenueVsExpenses,
  pendingProofs,
  periodSummary,
  receivables,
  rtoSummary,
  upcomingPayables,
} from "@/server/queries/dashboard";
import { chartPesos, DataTable, Section, Stat } from "./shared";

type P = { claims: JwtClaims; today: IsoDate };

/** One open-charges pass per request, shared by the Today and Due-lists sections. */
const loadReceivables = cache((claims: JwtClaims, today: IsoDate) => withUserTx(claims, (tx) => receivables(tx, today)));
type R = P & { from: IsoDate; to: IsoDate };

/** "2026-09" → "Sep 26" for chart ticks. */
const monthLabel = (m: string) => `${new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", timeZone: "UTC" })} ${m.slice(2, 4)}`;

const SOURCE_LABEL: Record<string, string> = {
  facebook_page: "Facebook page", messenger: "Messenger", fb_lead_ad: "Facebook Lead Ad", landing_page: "Website form",
  referral: "Referral", walk_in: "Walk-in", tiktok: "TikTok", other: "Other",
};

export async function TodaySection({ claims, today }: P) {
  const r = await loadReceivables(claims, today);
  const rate = collectionRateBps(r.collectedToday, r.expectedToday);
  const a = r.aging;
  return (
    <>
      <Section title="Today" description={`${today} · boundary due today vs boundary collected today`}>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Boundary expected" value={<Money value={r.expectedToday} />} />
          <Stat label="Boundary collected" value={<Money value={r.collectedToday} />} sub={<>all accounts: <Money value={r.allCollectedToday} /></>} />
          <Stat label="Collection rate" value={formatBps(rate)} sub="collected ÷ expected (late payments count when received)" />
          <Stat label="Drivers unpaid today" value={r.driversUnpaidToday} sub={<Link className="underline" href="/app/collections/today">Collect today →</Link>} />
        </div>
      </Section>
      <Section title="Outstanding driver balances" description={`${r.driversInArrears} driver(s) behind · payments apply to the oldest dues first`}>
        <p className="mb-3 text-2xl font-semibold"><Money value={a.total} /></p>
        <HBars
          ariaLabel="Outstanding by days past due"
          rows={[
            { label: "Not yet due", value: chartPesos(a.current), display: <Money value={a.current} /> },
            ...a.buckets.map((b, i) => ({ label: a.labels[i], value: chartPesos(b), display: <Money value={b} /> })),
          ]}
        />
        <p className="mt-2 text-xs"><Link className="underline" href="/app/reports/driver-aging">Aging report →</Link></p>
      </Section>
    </>
  );
}

export async function PeriodSection({ claims, from, to }: R) {
  const s = await withUserTx(claims, (tx) => periodSummary(tx, from, to));
  return (
    <Section title="Period" description={`${from === to ? from : `${from} to ${to}`} · cash received and spent`}>
      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
        <Stat label="Driver collections" value={<Money value={s.collections} />} />
        <Stat label="All revenue" value={<Money value={s.revenue} />} />
        <Stat label="Expenses" value={<Money value={s.expenses} />} sub="incl. payroll cost" />
        <Stat label="Net cash flow" value={<Money value={s.netCashFlow} />} sub={<>in <Money value={s.inflow} /> · out <Money value={s.outflow} /></>} />
      </div>
      <p className="mb-2 text-sm font-medium">Revenue by service line</p>
      <HBars ariaLabel="Revenue by service line" rows={s.byLine.map((l) => ({ label: l.label, value: chartPesos(l.amount), display: <Money value={l.amount} /> }))} />
      <p className="mt-2 text-xs"><Link className="underline" href={`/app/reports/sales?from=${from}&to=${to}`}>Sales report →</Link> · <Link className="underline" href={`/app/cashbook?from=${from}&to=${to}`}>Cash book →</Link></p>
    </Section>
  );
}

export async function FleetSection({ claims, today }: P) {
  const [f, rto] = await Promise.all([withUserTx(claims, (tx) => fleetCounts(tx)), withUserTx(claims, (tx) => rtoSummary(tx, today))]);
  return (
    <Section title="Fleet and RTO">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
        <Stat label="Active (assigned)" value={f.active} />
        <Stat label="Idle" value={f.idle} />
        <Stat label="In maintenance" value={f.maintenance} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{f.total} units · EV {f.ev} · ICE {f.ice}{f.hybrid ? ` · hybrid ${f.hybrid}` : ""}</p>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
        <Stat label="Active RTO contracts" value={rto.active} />
        <Stat label="Total receivable" value={<Money value={rto.receivable} />} sub="remaining principal" />
        <Stat label="In arrears" value={<Money value={rto.arrears} />} />
      </div>
      {rto.nearing.length ? (
        <div className="mt-3 text-sm">
          <p className="font-medium">Nearing completion ({rto.nearAt} or fewer installments left)</p>
          <ul className="text-muted-foreground">
            {rto.nearing.slice(0, 8).map((n) => <li key={n.contractNo}>{n.contractNo} · {n.driver} · {n.left} left</li>)}
          </ul>
        </div>
      ) : null}
      <p className="mt-2 text-xs"><Link className="underline" href="/app/reports/rto-portfolio">RTO portfolio →</Link> · <Link className="underline" href="/app/reports/vehicle">Vehicle report →</Link></p>
    </Section>
  );
}

export async function PayablesSection({ claims, today }: P) {
  const { items, days } = await withUserTx(claims, (tx) => upcomingPayables(tx, today));
  const total = items.reduce((s, i) => s + i.amount, ZERO);
  const kind = { loan: "Vehicle loan", bill: "Recurring bill", payroll: "Payroll" } as const;
  return (
    <Section title="Upcoming payables" description={<>Due within {days} days or overdue · <Money value={total} /></>}>
      {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing due.</p> : null}
      <ul className="divide-y text-sm">
        {items.slice(0, 12).map((i) => (
          <li key={`${i.kind}${i.label}${i.due}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span><Link className="underline" href={i.href}>{i.label}</Link> <span className="text-xs text-muted-foreground">{kind[i.kind]}</span></span>
            <span className="flex items-center gap-2"><Money value={i.amount} /><Badge variant={i.overdue ? "destructive" : "warning"}>{i.overdue ? "overdue" : "due"} {i.due}</Badge></span>
          </li>
        ))}
      </ul>
      {items.length > 12 ? <p className="text-xs text-muted-foreground">and {items.length - 12} more.</p> : null}
    </Section>
  );
}

export async function ApplicationsSection({ claims, from, to }: R) {
  const s = await withUserTx(claims, (tx) => applicationsSummary(tx, from, to));
  const open = s.byStatus.filter((x) => x.kind === "open" || x.kind === "on_hold" || x.kind === "approved");
  return (
    <Section title="Applications" description={`New and approved/activated ${from === to ? "today" : "in the period"}`}>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Stat label="New applications" value={s.created} />
        <Stat label="Approved / activated" value={s.approved} />
      </div>
      <HBars ariaLabel="Applications by status" rows={open.map((x) => ({ label: x.label, value: x.n, display: x.n }))} />
      <p className="mt-2 text-xs"><Link className="underline" href={`/app/reports/applications?from=${from}&to=${to}`}>Application report →</Link></p>
    </Section>
  );
}

export async function CrmSection({ claims, from, to }: R) {
  const s = await withUserTx(claims, (tx) => crmSummary(tx, from, to));
  return (
    <Section title="Leads (CRM)" description="Leads created in the period, where they are now">
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Stat label="New leads" value={s.total} />
        <Stat label="Conversion" value={formatBps(s.conversionBps)} sub={`${s.won} converted`} />
      </div>
      <p className="mb-2 text-sm font-medium">By source</p>
      <HBars ariaLabel="Leads by source" rows={s.bySource.map((x) => ({ label: SOURCE_LABEL[x.source] ?? x.source, value: x.n, display: x.n }))} />
      <p className="mt-2 text-xs"><Link className="underline" href={`/app/reports/crm-leads?from=${from}&to=${to}`}>Lead report →</Link></p>
    </Section>
  );
}

export async function CollectionsTrendSection({ claims, today }: P) {
  const rows = await withUserTx(claims, (tx) => dailyCollectionsTrend(tx, today));
  return (
    <Section title="Daily collections, last 30 days" description="Payments received per day vs dues falling due that day">
      <BarLineChart
        ariaLabel="Daily collections for the last 30 days"
        aName="Collected"
        bName="Due"
        data={rows.map((r) => ({ label: r.date.slice(5), a: chartPesos(r.collected), b: chartPesos(r.due) }))}
      />
      <DataTable columns={["Date", "Collected", "Due"]} rows={rows.map((r) => [r.date, <Money key="c" value={r.collected} />, <Money key="d" value={r.due} />])} />
    </Section>
  );
}

export async function RevenueTrendSection({ claims, today }: P) {
  const rows = await withUserTx(claims, (tx) => monthlyRevenueVsExpenses(tx, today));
  return (
    <Section title="Revenue vs expenses, last 12 months" description="Cash revenue received vs expenses recorded, per month">
      <PairedBarChart
        ariaLabel="Monthly revenue and expenses for the last 12 months"
        aName="Revenue"
        bName="Expenses"
        data={rows.map((r) => ({ label: monthLabel(r.month), a: chartPesos(r.revenue), b: chartPesos(r.expenses) }))}
      />
      <DataTable columns={["Month", "Revenue", "Expenses"]} rows={rows.map((r) => [r.month, <Money key="r" value={r.revenue} />, <Money key="e" value={r.expenses} />])} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Collections dashboard
// ---------------------------------------------------------------------------
export async function DueListsSection({ claims, today }: P) {
  const r = await loadReceivables(claims, today);
  const data = await withUserTx(claims, async (tx) => {
    const all = [...r.drivers.entries()];
    const due = all.filter(([, d]) => d.dueNow > ZERO).sort((a, b) => ((a[1].oldest ?? "") < (b[1].oldest ?? "") ? -1 : 1)).slice(0, 15);
    const overdue = all.filter(([, d]) => d.pastDue > ZERO).sort((a, b) => (b[1].pastDue > a[1].pastDue ? 1 : b[1].pastDue < a[1].pastDue ? -1 : 0)).slice(0, 10);
    const labels = await driverLabels(tx, [...new Set([...due, ...overdue].map(([id]) => id))]);
    return { r, due, overdue, labels, dueCount: all.filter(([, d]) => d.dueNow > ZERO).length };
  });
  const name = (id: string) => data.labels.get(id)?.name ?? "Driver";
  return (
    <>
      <Section title="Due today" description={`${data.dueCount} driver(s) with something due up to today, oldest first`}>
        <ul className="divide-y text-sm">
          {data.due.map(([id, d]) => (
            <li key={id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                <Link className="underline" href={`/app/collections/new?driver=${id}`}>{name(id)}</Link>
                <span className="block text-xs text-muted-foreground">{data.labels.get(id)?.plate ?? "No vehicle"} · {data.labels.get(id)?.phone}</span>
              </span>
              <span className="flex items-center gap-2">
                <Money value={d.dueNow} />
                {d.oldest && d.oldest < today ? <Badge variant="destructive">{daysBetween(d.oldest, today)}d behind</Badge> : <Badge variant="muted">today</Badge>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs"><Link className="underline" href="/app/collections/today">Full list (collector mode) →</Link></p>
      </Section>
      <Section title="Top overdue drivers" description="Largest past-due amounts">
        <Table>
          <thead><tr><Th>Driver</Th><Th className="text-right">Past due</Th><Th className="text-right">Days</Th></tr></thead>
          <tbody>
            {data.overdue.map(([id, d]) => (
              <tr key={id}>
                <Td><Link className="underline" href={`/app/drivers/${id}`}>{name(id)}</Link></Td>
                <Td className="text-right"><Money value={d.pastDue} /></Td>
                <Td className="text-right">{d.oldest ? daysBetween(d.oldest, today) : 0}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </>
  );
}

export async function ProofsSection({ claims, today }: P) {
  const proofs = await withUserTx(claims, (tx) => pendingProofs(tx));
  return (
    <Section title="Payment proofs waiting" description={proofs.length ? `${proofs.length} to verify` : "None waiting"}>
      <ul className="divide-y text-sm">
        {proofs.slice(0, 8).map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
            <span>{p.driver}<span className="block text-xs text-muted-foreground">{p.method.replace("_", " ")} · paid {p.paid_on}</span></span>
            <span className="flex items-center gap-2"><Money value={p.amount} />{p.paid_on < addDays(today, -2) ? <Badge variant="warning">waiting</Badge> : null}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs"><Link className="underline" href="/app/collections/proofs">Verify proofs →</Link></p>
    </Section>
  );
}

export async function VariancesSection({ claims, today }: P) {
  const v = await withUserTx(claims, (tx) => collectorVariances(tx, today));
  return (
    <Section title="Collector cash" description="Cash not yet remitted, and remittance differences in the last 30 days">
      {v.unremitted.length === 0 ? <p className="text-sm text-muted-foreground">All cash remitted.</p> : null}
      <ul className="divide-y text-sm">
        {v.unremitted.map((u) => (
          <li key={u.collector} className="flex items-center justify-between py-1.5">
            <span>{u.collector}<span className="block text-xs text-muted-foreground">since {u.oldest}</span></span>
            <Money value={u.amount} />
          </li>
        ))}
      </ul>
      {v.variances.length ? (
        <>
          <p className="mt-3 text-sm font-medium">Remittance differences</p>
          <ul className="divide-y text-sm">
            {v.variances.slice(0, 10).map((x, i) => (
              <li key={i} className="flex items-center justify-between py-1.5">
                <span>{x.date} · {x.collector}</span>
                <Badge variant={x.variance < ZERO ? "destructive" : "warning"}><Money value={x.variance} /></Badge>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-2 text-xs"><Link className="underline" href="/app/collections/remittances">Remittances →</Link></p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Sales dashboard
// ---------------------------------------------------------------------------
export async function SalesRevenueSection({ claims, from, to, appsOnly }: R & { appsOnly: boolean }) {
  const [s, apps] = await Promise.all([withUserTx(claims, (tx) => periodSummary(tx, from, to)), withUserTx(claims, (tx) => applicationsSummary(tx, from, to))]);
  const lines = appsOnly ? s.byLine.filter((l) => ["franchise", "activation", "other_apps"].includes(l.key)) : s.byLine;
  const billed = apps.byType.reduce((t, x) => t + x.fees_billed, ZERO);
  const collected = apps.byType.reduce((t, x) => t + x.fees_collected, ZERO);
  return (
    <>
      <Section title="Revenue by service line" description="Cash received in the period">
        <HBars ariaLabel="Revenue by service line" rows={lines.map((l) => ({ label: l.label, value: chartPesos(l.amount), display: <Money value={l.amount} /> }))} />
      </Section>
      <Section title="Documentation fees and activations" description={<>Billed <Money value={billed} /> · collected <Money value={collected} /></>}>
        <Table>
          <thead><tr><Th>Type</Th><Th className="text-right">Approved / activated</Th><Th className="text-right">Billed</Th><Th className="text-right">Collected</Th></tr></thead>
          <tbody>
            {apps.byType.map((t) => (
              <tr key={t.label}>
                <Td>{t.label}</Td><Td className="text-right">{t.approved}</Td>
                <Td className="text-right"><Money value={t.fees_billed} /></Td><Td className="text-right"><Money value={t.fees_collected} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </>
  );
}

export async function FunnelSection({ claims, from, to }: R) {
  const s = await withUserTx(claims, (tx) => crmSummary(tx, from, to));
  return (
    <>
      <Section title="Lead funnel" description={`${s.total} new leads · conversion ${formatBps(s.conversionBps)}`}>
        <HBars ariaLabel="Leads by stage" rows={s.funnel.map((f) => ({ label: f.label, value: f.n, display: f.n }))} />
      </Section>
      <Section title="Agent performance" description="Leads created in the period, by assigned agent">
        <Table>
          <thead><tr><Th>Agent</Th><Th className="text-right">Leads</Th><Th className="text-right">Converted</Th><Th className="text-right">Lost</Th><Th className="text-right">Conversion</Th><Th className="text-right">Overdue follow-ups</Th></tr></thead>
          <tbody>
            {s.agents.map((a) => (
              <tr key={a.agent}>
                <Td>{a.agent}</Td><Td className="text-right">{a.leads}</Td><Td className="text-right">{a.won}</Td><Td className="text-right">{a.lost}</Td>
                <Td className="text-right">{formatBps(a.conversionBps)}</Td><Td className="text-right">{a.overdue}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Expiring papers (OR/CR, insurance, franchises)
// ---------------------------------------------------------------------------
export async function ExpiringPapersCard({ claims, today }: P) {
  const { rows, warnDays, urgentDays } = await withUserTx(claims, (tx) => expiringDocuments(tx, today));
  if (rows.length === 0) return null;
  const urgentBy = addDays(today, urgentDays);
  const warnBy = addDays(today, warnDays);
  const levelled = rows.map((r) => ({ ...r, level: expiryLevel(r.expires_on, today, urgentBy, warnBy) })).filter((r) => r.level);
  const urgent = levelled.filter((r) => r.level !== "warn").length;
  return (
    <Section
      className={urgent ? "border-destructive/50" : "border-warning"}
      title="Expiring papers"
      description={`OR/CR, insurance and franchises expiring within ${warnDays} days (urgent within ${urgentDays}) or already expired`}
    >
      <ul className="divide-y text-sm">
        {levelled.slice(0, 15).map((r) => (
          <li key={`${r.kind}${r.vehicle_id}${r.label}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>
              {r.vehicle_id ? <Link className="underline" href={`/app/vehicles/${r.vehicle_id}`}>{r.plate_no ?? "Vehicle"}</Link> : (r.client_name ?? "—")} · {r.label}
            </span>
            <Badge variant={r.level === "warn" ? "warning" : "destructive"}>{r.level === "expired" ? "expired" : "expires"} {r.expires_on}</Badge>
          </li>
        ))}
      </ul>
      {levelled.length > 15 ? <p className="text-xs text-muted-foreground">and {levelled.length - 15} more.</p> : null}
    </Section>
  );
}

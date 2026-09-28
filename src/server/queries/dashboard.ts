import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { addDays, addMonths, startOfMonth, type IsoDate } from "@/lib/dates";
import { applyLoanPayments, type LoanLine } from "@/lib/loans";
import { agingBuckets, installmentsLeft, ratioBps } from "@/lib/metrics";
import { sum, ZERO, type Centavos } from "@/lib/money";
import { monthlyAmortization } from "@/lib/rto";
import { getSetting } from "@/server/office/settings";
import { recurringForMonth } from "@/server/office/expenses";
import { rtoPortfolio } from "@/server/reports/fleet";
import { UNREMITTED_CASH } from "./cashbook";
import { dailyRevenue, REVENUE_LINES } from "@/server/reports/sales";

/**
 * Dashboard read models (spec 5). Each function is one card/section; the page
 * runs them in parallel, each in its own transaction as the signed-in user, so
 * RLS decides what each role sees. Heavy lifting uses app.open_charges (fast
 * open dues) instead of v_charge_status.
 */

const NOT_VOID = sql`NOT EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id)`;

// ---------------------------------------------------------------------------
// Receivables: today, aging, who owes (one open-charges pass)
// ---------------------------------------------------------------------------
export type Receivables = Awaited<ReturnType<typeof receivables>>;

export async function receivables(tx: Tx, today: IsoDate) {
  const limits = await getSetting(tx, "dashboard.aging_bucket_days");
  const [byDriverDue, todayRow] = await Promise.all([
    tx.execute<{ driver_id: string; due_date: string; kind: string; o: string }>(sql`
      SELECT driver_id, due_date::text, account_kind::text AS kind, SUM(outstanding_centavos)::text AS o
      FROM app.open_charges(NULL) GROUP BY 1, 2, 3`),
    tx.execute<{ expected: string; collected: string; all_collected: string }>(sql`
      SELECT
        (SELECT COALESCE(SUM(e.amount_centavos), 0) FROM public.ledger_entries e
          WHERE e.due_date = ${today}::date AND e.entry_type = 'boundary_charge'
            AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id))::text AS expected,
        (SELECT COALESCE(SUM(pl.amount_centavos), 0) FROM public.payments p JOIN public.payment_lines pl ON pl.payment_id = p.id
          JOIN public.driver_accounts a ON a.id = pl.account_id
          WHERE p.business_date = ${today}::date AND a.kind = 'boundary' AND ${NOT_VOID})::text AS collected,
        (SELECT COALESCE(SUM(p.amount_centavos), 0) FROM public.payments p WHERE p.business_date = ${today}::date AND ${NOT_VOID})::text AS all_collected`),
  ]);
  const rows = byDriverDue.map((r) => ({ driverId: r.driver_id, dueDate: r.due_date as IsoDate, kind: r.kind, outstanding: BigInt(r.o) }));
  const aging = agingBuckets(rows, today, limits);
  const drivers = new Map<string, { pastDue: Centavos; dueNow: Centavos; oldest: IsoDate | null; unpaidToday: boolean }>();
  for (const r of rows) {
    if (r.dueDate > today) continue;
    const d = drivers.get(r.driverId) ?? { pastDue: ZERO, dueNow: ZERO, oldest: null, unpaidToday: false };
    d.dueNow += r.outstanding;
    if (r.dueDate < today) d.pastDue += r.outstanding;
    if (!d.oldest || r.dueDate < d.oldest) d.oldest = r.dueDate;
    if (r.dueDate === today && r.kind === "boundary") d.unpaidToday = true;
    drivers.set(r.driverId, d);
  }
  const t = todayRow[0];
  return {
    aging,
    expectedToday: BigInt(t.expected),
    collectedToday: BigInt(t.collected),
    allCollectedToday: BigInt(t.all_collected),
    driversUnpaidToday: [...drivers.values()].filter((d) => d.unpaidToday).length,
    driversInArrears: [...drivers.values()].filter((d) => d.pastDue > ZERO).length,
    drivers,
  };
}

/** Names/plates for a set of drivers (for lists built from receivables). */
export async function driverLabels(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, { name: string; plate: string | null; phone: string }>();
  const rows = await tx.execute<{ id: string; name: string; plate: string | null; phone: string }>(sql`
    SELECT d.id, d.last_name || ', ' || d.first_name AS name, d.phone,
      (SELECT v.plate_no FROM public.vehicle_assignments va JOIN public.vehicles v ON v.id = va.vehicle_id
        WHERE va.driver_id = d.id AND va.end_date IS NULL LIMIT 1) AS plate
    FROM public.drivers d WHERE d.id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Period: collections, revenue by service line, expenses, net cash flow
// ---------------------------------------------------------------------------
export async function periodSummary(tx: Tx, from: IsoDate, to: IsoDate) {
  const [rev, exp, flow] = await Promise.all([
    dailyRevenue(tx, from, to),
    tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(amount_centavos), 0)::text AS total FROM public.expenses
      WHERE voided_at IS NULL AND expense_date BETWEEN ${from}::date AND ${to}::date`),
    tx.execute<{ inflow: string; outflow: string }>(sql`
      SELECT COALESCE(SUM(signed_centavos) FILTER (WHERE signed_centavos > 0), 0)::text AS inflow,
        COALESCE(-SUM(signed_centavos) FILTER (WHERE signed_centavos < 0), 0)::text AS outflow
      FROM public.v_cash_movements WHERE operating AND entry_date BETWEEN ${from}::date AND ${to}::date`),
  ]);
  const byLine = REVENUE_LINES.map((l) => ({ ...l, amount: sum(rev.filter((r) => r.line === l.key).map((r) => r.amount)) }));
  const driverLines = new Set(["boundary", "rto", "driver_costs"]);
  const inflow = BigInt(flow[0].inflow);
  const outflow = BigInt(flow[0].outflow);
  return {
    collections: sum(byLine.filter((l) => driverLines.has(l.key)).map((l) => l.amount)),
    revenue: sum(byLine.map((l) => l.amount)),
    byLine,
    expenses: BigInt(exp[0].total),
    inflow,
    outflow,
    netCashFlow: inflow - outflow,
  };
}

// ---------------------------------------------------------------------------
// Fleet and RTO
// ---------------------------------------------------------------------------
export async function fleetCounts(tx: Tx) {
  const rows = await tx.execute<{ status: string; powertrain: string; n: number }>(sql`
    SELECT status::text, powertrain::text, count(*)::int AS n FROM public.vehicles
    WHERE status NOT IN ('transferred', 'retired') GROUP BY 1, 2`);
  const by = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((s, r) => s + r.n, 0);
  return {
    active: by((r) => r.status === "assigned"),
    idle: by((r) => r.status === "available"),
    maintenance: by((r) => r.status === "maintenance"),
    ev: by((r) => r.powertrain === "ev"),
    ice: by((r) => r.powertrain === "ice"),
    hybrid: by((r) => r.powertrain === "hybrid"),
    total: by(() => true),
  };
}

export async function rtoSummary(tx: Tx, today: IsoDate) {
  const [list, nearAt] = await Promise.all([rtoPortfolio(tx, { includeClosed: false }), getSetting(tx, "dashboard.rto_nearing_completion_installments")]);
  let receivable = ZERO;
  let arrears = ZERO;
  const nearing: { contractNo: string; driver: string; left: number }[] = [];
  for (const { row, terms, posted, netCredits } of list) {
    const paid = netCredits < ZERO ? ZERO : netCredits > terms.contractPrice ? terms.contractPrice : netCredits;
    const remaining = terms.contractPrice - paid;
    receivable += remaining;
    if (posted - netCredits > ZERO) arrears += posted - netCredits;
    const left = installmentsLeft(remaining, monthlyAmortization(terms));
    if (left <= nearAt) nearing.push({ contractNo: row.contract_no, driver: row.driver, left });
  }
  void today;
  return { active: list.length, receivable, arrears, nearing: nearing.sort((a, b) => a.left - b.left), nearAt };
}

// ---------------------------------------------------------------------------
// Upcoming payables: loan dues, recurring bills, payroll
// ---------------------------------------------------------------------------
export type Payable = { kind: "loan" | "bill" | "payroll"; label: string; due: IsoDate; amount: Centavos; overdue: boolean; href: string };

export type LoanDue = { loan_id: string; lender: string; plate_no: string; due_date: string; amount_due: string; overdue: boolean };

/**
 * Unpaid loan installments due by `until` (incl. overdue) for every active loan,
 * in two queries. Same oldest-first application as the loan page (applyLoanPayments).
 */
export async function loanDues(tx: Tx, today: IsoDate, until: IsoDate): Promise<LoanDue[]> {
  const [lines, paid] = await Promise.all([
    tx.execute<{ loan_id: string; lender: string; plate: string; seq: number; due_date: string; opening: string; principal: string; interest: string; payment: string; closing: string }>(sql`
      SELECT l.id AS loan_id, l.lender, v.plate_no AS plate, s.seq, s.due_date::text, s.opening_balance_centavos::text AS opening,
        s.principal_centavos::text AS principal, s.interest_centavos::text AS interest, s.payment_centavos::text AS payment, s.closing_balance_centavos::text AS closing
      FROM public.vehicle_loans l JOIN public.vehicles v ON v.id = l.vehicle_id JOIN public.loan_schedule_lines s ON s.loan_id = l.id
      WHERE l.status = 'active' ORDER BY l.id, s.seq`),
    tx.execute<{ loan_id: string; total: string }>(sql`
      SELECT lp.loan_id, SUM(lp.amount_centavos)::text AS total FROM public.loan_payments lp
      JOIN public.vehicle_loans l ON l.id = lp.loan_id WHERE l.status = 'active' GROUP BY 1`),
  ]);
  const out: LoanDue[] = [];
  const byLoan = new Map<string, (typeof lines)[number][]>();
  for (const l of lines) byLoan.set(l.loan_id, [...(byLoan.get(l.loan_id) ?? []), l]);
  for (const [loanId, ls] of byLoan) {
    const sched: LoanLine[] = ls.map((l) => ({
      seq: l.seq,
      dueDate: l.due_date as IsoDate,
      opening: BigInt(l.opening),
      principal: BigInt(l.principal),
      interest: BigInt(l.interest),
      payment: BigInt(l.payment),
      closing: BigInt(l.closing),
    }));
    const total = BigInt(paid.find((p) => p.loan_id === loanId)?.total ?? "0");
    for (const st of applyLoanPayments(sched, total, today)) {
      if (st.status === "paid" || st.dueDate > until) continue;
      out.push({ loan_id: loanId, lender: ls[0].lender, plate_no: ls[0].plate, due_date: st.dueDate, amount_due: (st.payment - st.paid).toString(), overdue: st.overdue });
    }
  }
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}

export async function upcomingPayables(tx: Tx, today: IsoDate): Promise<{ items: Payable[]; days: number }> {
  const days = await getSetting(tx, "dashboard.upcoming_payables_days");
  const until = addDays(today, days);
  const [loans, payroll, billsThis, billsNext] = await Promise.all([
    loanDues(tx, today, until),
    tx.execute<{ id: string; period_start: string; period_end: string; pay_date: string; net: string }>(sql`
      SELECT p.id, p.period_start::text, p.period_end::text, p.pay_date::text,
        COALESCE((SELECT SUM(l.net_pay_centavos) FROM public.payroll_lines l WHERE l.period_id = p.id), 0)::text AS net
      FROM public.payroll_periods p WHERE p.status <> 'paid' AND p.pay_date <= ${until}::date ORDER BY p.pay_date`),
    recurringForMonth(tx, startOfMonth(today)),
    until >= addMonths(startOfMonth(today), 1) ? recurringForMonth(tx, addMonths(startOfMonth(today), 1)) : Promise.resolve([]),
  ]);
  const items: Payable[] = loans.map((l) => ({
    kind: "loan" as const,
    label: `${l.plate_no} · ${l.lender}`,
    due: l.due_date as IsoDate,
    amount: BigInt(l.amount_due),
    overdue: l.overdue,
    href: `/app/loans/${l.loan_id}`,
  }));
  for (const b of [...billsThis, ...billsNext]) {
    if (b.paid_expense_id || (b.due_date as IsoDate) > until) continue;
    items.push({ kind: "bill", label: `${b.vendor} · ${b.category}`, due: b.due_date as IsoDate, amount: BigInt(b.amount), overdue: b.due_date < today, href: "/app/expenses" });
  }
  for (const p of payroll) {
    items.push({ kind: "payroll", label: `Payroll ${p.period_start} – ${p.period_end} (net pay)`, due: p.pay_date as IsoDate, amount: BigInt(p.net), overdue: p.pay_date < today, href: `/app/payroll/${p.id}` });
  }
  return { items: items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0)), days };
}

// ---------------------------------------------------------------------------
// Applications and CRM
// ---------------------------------------------------------------------------
const manilaDay = (col: ReturnType<typeof sql.raw>) => sql`(${col} AT TIME ZONE 'Asia/Manila')::date`;

export async function applicationsSummary(tx: Tx, from: IsoDate, to: IsoDate) {
  const [byStatus, counts, byType] = await Promise.all([
    tx.execute<{ label: string; kind: string; n: number }>(sql`
      SELECT s.label, s.kind::text, count(a.id)::int AS n FROM public.application_statuses s
      LEFT JOIN public.applications a ON a.status_key = s.key
      WHERE s.active GROUP BY s.key, s.label, s.kind, s.sort ORDER BY s.sort`),
    tx.execute<{ created: number; approved: number }>(sql`
      SELECT count(*) FILTER (WHERE ${manilaDay(sql.raw("created_at"))} BETWEEN ${from}::date AND ${to}::date)::int AS created,
        count(*) FILTER (WHERE ${manilaDay(sql.raw("approved_at"))} BETWEEN ${from}::date AND ${to}::date)::int AS approved
      FROM public.applications`),
    tx.execute<{ label: string; approved: number; fees_billed: string; fees_collected: string }>(sql`
      SELECT t.label,
        (SELECT count(*) FROM public.applications a WHERE a.type_key = t.key AND ${manilaDay(sql.raw("a.approved_at"))} BETWEEN ${from}::date AND ${to}::date)::int AS approved,
        COALESCE((SELECT SUM(f.amount_centavos) FROM public.application_fees f JOIN public.applications a ON a.id = f.application_id
          WHERE a.type_key = t.key AND f.voided_at IS NULL AND ${manilaDay(sql.raw("f.created_at"))} BETWEEN ${from}::date AND ${to}::date), 0)::text AS fees_billed,
        COALESCE((SELECT SUM(p.amount_centavos) FROM public.application_payments p JOIN public.applications a ON a.id = p.application_id
          WHERE a.type_key = t.key AND p.voided_at IS NULL AND p.received_on BETWEEN ${from}::date AND ${to}::date), 0)::text AS fees_collected
      FROM public.application_types t WHERE t.active ORDER BY t.sort`),
  ]);
  return {
    byStatus,
    created: counts[0].created,
    approved: counts[0].approved,
    byType: byType.map((t) => ({ ...t, fees_billed: BigInt(t.fees_billed), fees_collected: BigInt(t.fees_collected) })),
  };
}

const LEAD_RANGE = (from: IsoDate, to: IsoDate) =>
  sql`l.created_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Manila') AND l.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')`;

export async function crmSummary(tx: Tx, from: IsoDate, to: IsoDate) {
  const [bySource, funnel, agents] = await Promise.all([
    tx.execute<{ source: string; n: number; won: number }>(sql`
      SELECT l.source::text AS source, count(*)::int AS n, count(*) FILTER (WHERE s.kind = 'won')::int AS won
      FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key WHERE ${LEAD_RANGE(from, to)} GROUP BY 1 ORDER BY 2 DESC`),
    tx.execute<{ label: string; kind: string; n: number }>(sql`
      SELECT s.label, s.kind::text, count(l.id)::int AS n FROM public.lead_stages s
      LEFT JOIN public.leads l ON l.stage_key = s.key AND ${LEAD_RANGE(from, to)}
      WHERE s.active GROUP BY s.key, s.label, s.kind, s.sort ORDER BY s.sort`),
    tx.execute<{ agent: string; leads: number; won: number; lost: number; overdue: number }>(sql`
      SELECT COALESCE((SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = l.assigned_to), 'Unassigned') AS agent,
        count(*)::int AS leads, count(*) FILTER (WHERE s.kind = 'won')::int AS won, count(*) FILTER (WHERE s.kind = 'lost')::int AS lost,
        (SELECT count(*) FROM public.lead_followups f WHERE f.assigned_to IS NOT DISTINCT FROM l.assigned_to AND f.done_at IS NULL AND f.due_on < ${to}::date)::int AS overdue
      FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key WHERE ${LEAD_RANGE(from, to)}
      GROUP BY l.assigned_to ORDER BY 2 DESC`),
  ]);
  const total = bySource.reduce((s, r) => s + r.n, 0);
  const won = bySource.reduce((s, r) => s + r.won, 0);
  return { total, won, conversionBps: ratioBps(won, total), bySource, funnel, agents: agents.map((a) => ({ ...a, conversionBps: ratioBps(a.won, a.leads) })) };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------
/** Driver collections per day for the last `days` days, with boundary due, for the trend chart. */
export async function dailyCollectionsTrend(tx: Tx, today: IsoDate, days = 30) {
  const from = addDays(today, -(days - 1));
  const rows = await tx.execute<{ d: string; collected: string; due: string }>(sql`
    WITH days AS (SELECT generate_series(${from}::date, ${today}::date, interval '1 day')::date AS d),
    col AS (SELECT p.business_date AS d, SUM(p.amount_centavos) AS amt FROM public.payments p
      WHERE p.business_date BETWEEN ${from}::date AND ${today}::date AND ${NOT_VOID} GROUP BY 1),
    due AS (SELECT e.due_date AS d, SUM(e.amount_centavos) AS amt FROM public.ledger_entries e
      WHERE e.due_date BETWEEN ${from}::date AND ${today}::date AND e.amount_centavos > 0 AND e.entry_type <> 'reversal'
        AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id) GROUP BY 1)
    SELECT days.d::text, COALESCE(col.amt, 0)::text AS collected, COALESCE(due.amt, 0)::text AS due
    FROM days LEFT JOIN col ON col.d = days.d LEFT JOIN due ON due.d = days.d ORDER BY days.d`);
  return rows.map((r) => ({ date: r.d, collected: BigInt(r.collected), due: BigInt(r.due) }));
}

/** Revenue (cash received) vs expenses per month for the last 12 months. */
export async function monthlyRevenueVsExpenses(tx: Tx, today: IsoDate, months = 12) {
  const from = addMonths(startOfMonth(today), -(months - 1));
  const [rev, exp] = await Promise.all([
    // Same sources and filters as dailyRevenue, but whole payments (no per-account split needed for a total).
    tx.execute<{ d: string; amount: string }>(sql`
      SELECT to_char(p.business_date, 'YYYY-MM') AS d, SUM(p.amount_centavos)::text AS amount FROM public.payments p
      WHERE p.business_date BETWEEN ${from}::date AND ${today}::date AND ${NOT_VOID} GROUP BY 1
      UNION ALL
      SELECT to_char(received_on, 'YYYY-MM'), SUM(amount_centavos)::text FROM public.application_payments
      WHERE voided_at IS NULL AND received_on BETWEEN ${from}::date AND ${today}::date GROUP BY 1
      UNION ALL
      SELECT to_char(received_on, 'YYYY-MM'), SUM(amount_centavos)::text FROM public.commissions_received
      WHERE voided_at IS NULL AND received_on BETWEEN ${from}::date AND ${today}::date GROUP BY 1
      UNION ALL
      SELECT to_char(entry_date, 'YYYY-MM'), SUM(amount_centavos)::text FROM public.cash_transactions
      WHERE category = 'platform_revenue' AND voided_at IS NULL AND entry_date BETWEEN ${from}::date AND ${today}::date GROUP BY 1`),
    tx.execute<{ m: string; amt: string }>(sql`
      SELECT to_char(expense_date, 'YYYY-MM') AS m, SUM(amount_centavos)::text AS amt FROM public.expenses
      WHERE voided_at IS NULL AND expense_date BETWEEN ${from}::date AND ${today}::date GROUP BY 1`),
  ]);
  const out: { month: string; revenue: Centavos; expenses: Centavos }[] = [];
  for (let i = 0; i < months; i++) {
    const m = addMonths(from, i).slice(0, 7);
    out.push({
      month: m,
      revenue: sum(rev.filter((r) => r.d === m).map((r) => BigInt(r.amount))),
      expenses: BigInt(exp.find((e) => e.m === m)?.amt ?? "0"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collections dashboard extras
// ---------------------------------------------------------------------------
export async function pendingProofs(tx: Tx) {
  return tx.execute<{ id: string; driver: string; amount: string; method: string; paid_on: string; submitted_at: Date }>(sql`
    SELECT p.id, d.last_name || ', ' || d.first_name AS driver, p.amount_centavos::text AS amount, p.method::text, p.paid_on::text, p.submitted_at
    FROM public.payment_proofs p JOIN public.drivers d ON d.id = p.driver_id
    WHERE p.status = 'pending' ORDER BY p.submitted_at LIMIT 50`);
}

/** Remittances with a shortage/overage in the last N days (voided payments excluded), and cash still with collectors. */
export async function collectorVariances(tx: Tx, today: IsoDate, days = 30) {
  const [variances, unremitted] = await Promise.all([
    tx.execute<{ date: string; collector: string; expected: string; remitted: string; voided: string }>(sql`
      SELECT r.business_date::text AS date, COALESCE(NULLIF(c.full_name, ''), c.email) AS collector,
        r.expected_centavos::text AS expected, r.remitted_centavos::text AS remitted,
        COALESCE((SELECT SUM(p.amount_centavos) FROM public.remittance_payments rp JOIN public.payments p ON p.id = rp.payment_id
          JOIN public.payment_voids v ON v.payment_id = p.id WHERE rp.remittance_id = r.id), 0)::text AS voided
      FROM public.remittances r JOIN public.profiles c ON c.id = r.collector_id
      WHERE r.business_date >= ${addDays(today, -days)}::date ORDER BY r.business_date DESC`),
    tx.execute<{ collector: string; amount: string; oldest: string }>(sql`
      SELECT COALESCE(NULLIF(c.full_name, ''), c.email) AS collector, SUM(u.amount_centavos)::text AS amount, MIN(u.business_date)::text AS oldest
      FROM ${UNREMITTED_CASH} u JOIN public.profiles c ON c.id = u.collector_id GROUP BY 1 ORDER BY 2 DESC`),
  ]);
  return {
    variances: variances
      .map((v) => ({ ...v, variance: BigInt(v.remitted) - (BigInt(v.expected) - BigInt(v.voided)) }))
      .filter((v) => v.variance !== ZERO),
    unremitted: unremitted.map((u) => ({ ...u, amount: BigInt(u.amount) })),
  };
}

type Section = (tx: Tx, today: IsoDate) => Promise<unknown>;

/** The sections of each dashboard, for scripts/perf/measure.perf.ts (the page composes the same functions). */
export const DASHBOARDS_FOR_PERF: Record<string, Record<string, Section>> = {
  business: {
    "receivables (today, aging)": receivables,
    "period summary (month)": (tx, today) => periodSummary(tx, startOfMonth(today), today),
    "fleet counts": (tx) => fleetCounts(tx),
    "RTO portfolio summary": rtoSummary,
    "upcoming payables": upcomingPayables,
    "applications (month)": (tx, today) => applicationsSummary(tx, startOfMonth(today), today),
    "CRM (month)": (tx, today) => crmSummary(tx, startOfMonth(today), today),
    "trend: daily collections 30 days": (tx, today) => dailyCollectionsTrend(tx, today),
    "trend: revenue vs expenses 12 months": (tx, today) => monthlyRevenueVsExpenses(tx, today),
  },
  collections: {
    "receivables (due today, top overdue)": receivables,
    "pending proofs": (tx) => pendingProofs(tx),
    "collector variances": collectorVariances,
    "trend: daily collections 30 days": (tx, today) => dailyCollectionsTrend(tx, today),
  },
  sales: {
    "applications (month)": (tx, today) => applicationsSummary(tx, startOfMonth(today), today),
    "CRM (month)": (tx, today) => crmSummary(tx, startOfMonth(today), today),
    "revenue by line (month)": (tx, today) => periodSummary(tx, startOfMonth(today), today),
  },
};

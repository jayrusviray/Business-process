import { sql } from "drizzle-orm";
import { collectionRateBps } from "@/lib/collections";
import { daysBetween, type IsoDate } from "@/lib/dates";
import { agingBuckets, bucketLabel, bucketStart, bucketsBetween, groupSums, type GroupBy } from "@/lib/metrics";
import { ZERO } from "@/lib/money";
import { getDriverStatements } from "@/server/money/payments";
import { renderStatementPdf } from "@/server/pdf/statement";
import { getSetting } from "@/server/office/settings";
import type { ReportDef } from "./types";

const COLLECTIONS = ["owner_admin", "finance", "operations"] as const;

/** Debits that still exist (not a reversal and not reversed). */
const ACTIVE_DEBIT = sql`e.amount_centavos > 0 AND e.entry_type <> 'reversal'
  AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id)`;
const NOT_VOID = sql`NOT EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id)`;

export const dailyCollection: ReportDef = {
  key: "daily-collection",
  title: "Daily Collection Report",
  description: "Per driver and day: what fell due, what was paid, how, to whom, and the difference.",
  group: "Collections",
  roles: COLLECTIONS,
  defaultRange: "today",
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "driver", label: "Driver", type: "text" },
    { key: "plate", label: "Vehicle", type: "text" },
    { key: "expected", label: "Due that day", type: "money", total: true },
    { key: "paid", label: "Paid", type: "money", total: true },
    { key: "variance", label: "Paid − due", type: "money", total: true },
    { key: "method", label: "Method", type: "text" },
    { key: "collector", label: "Collector", type: "text" },
  ],
  async run(tx, { from, to }) {
    const rows = await tx.execute<{ date: string; driver: string; plate: string | null; expected: string; paid: string; method: string | null; collector: string | null }>(sql`
      WITH exp AS (
        SELECT e.driver_id, e.due_date AS d, SUM(e.amount_centavos) AS amt
        FROM public.ledger_entries e
        WHERE e.due_date BETWEEN ${from}::date AND ${to}::date AND ${ACTIVE_DEBIT}
        GROUP BY 1, 2
      ), pay AS (
        SELECT p.driver_id, p.business_date AS d, SUM(p.amount_centavos) AS amt,
          string_agg(DISTINCT replace(p.method::text, '_', ' '), ', ') AS method,
          string_agg(DISTINCT COALESCE(NULLIF(c.full_name, ''), c.email), ', ') AS collector
        FROM public.payments p JOIN public.profiles c ON c.id = p.collector_id
        WHERE p.business_date BETWEEN ${from}::date AND ${to}::date AND ${NOT_VOID}
        GROUP BY 1, 2
      )
      SELECT COALESCE(exp.d, pay.d)::text AS date, dr.last_name || ', ' || dr.first_name AS driver,
        (SELECT v.plate_no FROM public.vehicle_assignments va JOIN public.vehicles v ON v.id = va.vehicle_id
          WHERE va.driver_id = dr.id AND va.start_date <= COALESCE(exp.d, pay.d) AND (va.end_date IS NULL OR va.end_date >= COALESCE(exp.d, pay.d)) LIMIT 1) AS plate,
        COALESCE(exp.amt, 0)::text AS expected, COALESCE(pay.amt, 0)::text AS paid, pay.method, pay.collector
      FROM exp FULL JOIN pay ON pay.driver_id = exp.driver_id AND pay.d = exp.d
      JOIN public.drivers dr ON dr.id = COALESCE(exp.driver_id, pay.driver_id)
      ORDER BY 1, 2`);
    return {
      rows: rows.map((r) => ({ ...r, expected: BigInt(r.expected), paid: BigInt(r.paid), variance: BigInt(r.paid) - BigInt(r.expected) })),
      notes: ["Due = boundary, amortization and cost charges falling due that day (reversed charges excluded). Paid = payments received that day, any account, voids excluded."],
    };
  },
};

const GROUP_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "collector", label: "Collector" },
  { value: "account", label: "Program / account" },
];
const ACCOUNT_LABEL: Record<string, string> = { boundary: "Boundary", amortization: "RTO amortization", charges: "Driver costs & deposits" };

export const collectionSummary: ReportDef = {
  key: "collection-summary",
  title: "Collection Summary",
  description: "Due vs collected by day, week, month, collector or program, with the collection rate.",
  group: "Collections",
  roles: COLLECTIONS,
  defaultRange: "this_month",
  params: [{ key: "by", label: "Group by", options: GROUP_OPTIONS, default: "day" }],
  columns: (ctx) => [
    { key: "group", label: GROUP_OPTIONS.find((g) => g.value === ctx.params.by)?.label ?? "Group", type: "text" },
    ...(ctx.params.by === "collector" ? [{ key: "payments", label: "Payments", type: "int" as const, total: true }] : [{ key: "expected", label: "Due", type: "money" as const, total: true }]),
    { key: "collected", label: "Collected", type: "money", total: true },
    ...(ctx.params.by === "collector"
      ? [
          { key: "cash", label: "Cash", type: "money" as const, total: true },
          { key: "noncash", label: "GCash / Maya / bank", type: "money" as const, total: true },
        ]
      : [{ key: "rate", label: "Collection rate", type: "pct" as const }]),
  ],
  async run(tx, { from, to, params }) {
    const by = params.by;
    if (by === "collector") {
      const rows = await tx.execute<{ group: string; payments: number; collected: string; cash: string; noncash: string }>(sql`
        SELECT COALESCE(NULLIF(c.full_name, ''), c.email) AS group, count(*)::int AS payments, SUM(p.amount_centavos)::text AS collected,
          COALESCE(SUM(p.amount_centavos) FILTER (WHERE p.method = 'cash'), 0)::text AS cash,
          COALESCE(SUM(p.amount_centavos) FILTER (WHERE p.method <> 'cash'), 0)::text AS noncash
        FROM public.payments p JOIN public.profiles c ON c.id = p.collector_id
        WHERE p.business_date BETWEEN ${from}::date AND ${to}::date AND ${NOT_VOID}
        GROUP BY 1 ORDER BY 1`);
      return { rows: rows.map((r) => ({ ...r, collected: BigInt(r.collected), cash: BigInt(r.cash), noncash: BigInt(r.noncash) })) };
    }
    const daily = await tx.execute<{ d: string; kind: string; expected: string; collected: string }>(sql`
      WITH exp AS (
        SELECT e.due_date AS d, a.kind, SUM(e.amount_centavos) AS amt
        FROM public.ledger_entries e JOIN public.driver_accounts a ON a.id = e.account_id
        WHERE e.due_date BETWEEN ${from}::date AND ${to}::date AND ${ACTIVE_DEBIT}
        GROUP BY 1, 2
      ), col AS (
        SELECT p.business_date AS d, a.kind, SUM(pl.amount_centavos) AS amt
        FROM public.payments p JOIN public.payment_lines pl ON pl.payment_id = p.id JOIN public.driver_accounts a ON a.id = pl.account_id
        WHERE p.business_date BETWEEN ${from}::date AND ${to}::date AND ${NOT_VOID}
        GROUP BY 1, 2
      )
      SELECT COALESCE(exp.d, col.d)::text AS d, COALESCE(exp.kind, col.kind)::text AS kind,
        COALESCE(exp.amt, 0)::text AS expected, COALESCE(col.amt, 0)::text AS collected
      FROM exp FULL JOIN col ON col.d = exp.d AND col.kind = exp.kind`);
    const key =
      by === "account"
        ? (r: (typeof daily)[number]) => ACCOUNT_LABEL[r.kind] ?? r.kind
        : (r: (typeof daily)[number]) => bucketLabel(bucketStart(r.d as IsoDate, by as GroupBy), by as GroupBy);
    const g = groupSums(daily, key, ["expected", "collected"] as const, (r, f) => BigInt(r[f]));
    const order =
      by === "account"
        ? Object.values(ACCOUNT_LABEL).filter((l) => g.has(l))
        : bucketsBetween(from, to, by as GroupBy).map((b) => bucketLabel(b, by as GroupBy));
    return {
      rows: order.map((label) => {
        const s = g.get(label)?.sums ?? { expected: ZERO, collected: ZERO };
        return { group: label, expected: s.expected, collected: s.collected, rate: collectionRateBps(s.collected, s.expected) };
      }),
      notes: ["Collected = payments received in the period (arrears paid late count when received); the rate can exceed 100% when drivers catch up."],
    };
  },
};

export const driverAging: ReportDef = {
  key: "driver-aging",
  title: "Driver Balance / Aging Report",
  description: "Every driver's balance, overdue amounts by age, days behind and last payment, as of a date.",
  group: "Collections",
  roles: COLLECTIONS,
  defaultRange: "today",
  rangeKind: "as_of",
  landscape: true,
  columns: [
    { key: "driver", label: "Driver", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "plate", label: "Vehicle", type: "text" },
    { key: "balance", label: "Balance", type: "money", total: true },
    { key: "current", label: "Not yet due", type: "money", total: true },
    { key: "b1", label: "1–7 days", type: "money", total: true },
    { key: "b2", label: "8–15 days", type: "money", total: true },
    { key: "b3", label: "16–30 days", type: "money", total: true },
    { key: "b4", label: "Over 30 days", type: "money", total: true },
    { key: "days_behind", label: "Days behind", type: "int" },
    { key: "last_payment", label: "Last payment", type: "date" },
  ],
  async run(tx, { to }) {
    const limits = await getSetting(tx, "dashboard.aging_bucket_days");
    const [open, drivers] = await Promise.all([
      tx.execute<{ driver_id: string; due_date: string; o: string }>(sql`
        SELECT driver_id, due_date::text, SUM(outstanding_centavos)::text AS o FROM app.open_charges(${to}::date) GROUP BY 1, 2`),
      tx.execute<{ id: string; driver: string; status: string; plate: string | null; balance: string; last_payment: string | null }>(sql`
        WITH bal AS (
          SELECT e.driver_id, SUM(e.amount_centavos) AS b FROM public.ledger_entries e WHERE e.business_date <= ${to}::date GROUP BY 1
        ), lastpay AS (
          SELECT p.driver_id, MAX(p.business_date) AS d FROM public.payments p
          WHERE p.business_date <= ${to}::date AND ${NOT_VOID} GROUP BY 1
        )
        SELECT d.id, d.last_name || ', ' || d.first_name AS driver, d.status::text,
          (SELECT v.plate_no FROM public.vehicle_assignments va JOIN public.vehicles v ON v.id = va.vehicle_id
            WHERE va.driver_id = d.id AND va.start_date <= ${to}::date AND (va.end_date IS NULL OR va.end_date >= ${to}::date) LIMIT 1) AS plate,
          COALESCE(bal.b, 0)::text AS balance, lastpay.d::text AS last_payment
        FROM public.drivers d LEFT JOIN bal ON bal.driver_id = d.id LEFT JOIN lastpay ON lastpay.driver_id = d.id
        WHERE bal.b IS NOT NULL
        ORDER BY 2`),
    ]);
    const byDriver = new Map<string, { dueDate: IsoDate; outstanding: bigint }[]>();
    for (const o of open) byDriver.set(o.driver_id, [...(byDriver.get(o.driver_id) ?? []), { dueDate: o.due_date as IsoDate, outstanding: BigInt(o.o) }]);
    const rows = drivers.map((d) => {
      const list = byDriver.get(d.id) ?? [];
      const a = agingBuckets(list, to, limits);
      const oldest = list.filter((x) => x.dueDate < to).map((x) => x.dueDate).sort()[0];
      return {
        driver: d.driver,
        status: d.status,
        plate: d.plate,
        balance: BigInt(d.balance),
        current: a.current,
        b1: a.buckets[0],
        b2: a.buckets[1],
        b3: a.buckets[2],
        b4: a.buckets[3],
        days_behind: oldest ? daysBetween(oldest, to) : 0,
        last_payment: d.last_payment,
      };
    });
    const labels = agingBuckets([], to, limits).labels;
    return {
      rows: rows.sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0)),
      notes: [
        `Buckets: ${labels.join(", ")} past due (setting dashboard.aging_bucket_days). Payments apply to the oldest dues first within each account.`,
        "Balance nets every account; a driver paid ahead on one account can show a negative balance while owing on another.",
      ],
    };
  },
};

export const driverStatement: ReportDef = {
  key: "driver-statement",
  title: "Driver Statement of Account",
  description: "One driver's ledger for a period, per account, with the balance brought forward. The PDF is the same statement the driver gets.",
  group: "Collections",
  roles: COLLECTIONS,
  defaultRange: "last_30_days",
  params: [
    {
      key: "driver",
      label: "Driver",
      default: "",
      options: async (tx) => [
        { value: "", label: "Choose a driver…" },
        ...(await tx.execute<{ value: string; label: string }>(sql`
          SELECT id::text AS value, last_name || ', ' || first_name AS label FROM public.drivers ORDER BY last_name, first_name`)),
      ],
    },
  ],
  columns: [
    { key: "account", label: "Account", type: "text" },
    { key: "date", label: "Date", type: "date" },
    { key: "description", label: "Description", type: "text" },
    { key: "charge", label: "Charge", type: "money", total: true },
    { key: "credit", label: "Credit", type: "money", total: true },
    { key: "balance", label: "Balance", type: "money" },
  ],
  async run(tx, { from, to, params }) {
    if (!params.driver) return { rows: [], notes: ["Choose a driver."] };
    const statements = await getDriverStatements(tx, params.driver);
    const rows = [];
    for (const st of statements) {
      const label = ACCOUNT_LABEL[st.account.kind] ?? st.account.kind;
      let running = st.entries.filter((e) => e.businessDate < from).reduce((s, e) => s + e.amountCentavos, ZERO);
      rows.push({ account: label, date: from, description: "Balance brought forward", charge: null, credit: null, balance: running });
      for (const e of st.entries.filter((x) => x.businessDate >= from && x.businessDate <= to)) {
        running += e.amountCentavos;
        rows.push({
          account: label,
          date: e.businessDate,
          description: `${e.entryType.replaceAll("_", " ")}${e.memo ? ` – ${e.memo}` : ""}`,
          charge: e.amountCentavos > ZERO ? e.amountCentavos : null,
          credit: e.amountCentavos < ZERO ? -e.amountCentavos : null,
          balance: running,
        });
      }
    }
    return { rows, totals: null };
  },
  async pdf(tx, { from, to, params }) {
    if (!params.driver) return null;
    const data = await renderStatementPdf(tx, params.driver, from, to);
    return data ? { data, filename: `statement-${from}-to-${to}.pdf` } : null;
  },
};

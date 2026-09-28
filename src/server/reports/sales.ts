import { sql } from "drizzle-orm";
import type { IsoDate } from "@/lib/dates";
import { bucketLabel, bucketStart, bucketsBetween, groupSums, ratioBps, type GroupBy } from "@/lib/metrics";
import { ZERO } from "@/lib/money";
import type { ReportDef } from "./types";

const PERIODS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

/** Revenue lines (cash received). Keys are the report columns. */
export const REVENUE_LINES = [
  { key: "boundary", label: "Boundary" },
  { key: "rto", label: "RTO / amortization" },
  { key: "driver_costs", label: "Driver costs & deposits" },
  { key: "franchise", label: "Franchise documentation" },
  { key: "activation", label: "Platform activation" },
  { key: "other_apps", label: "Other application fees" },
  { key: "commissions", label: "Commissions received" },
  { key: "platform", label: "Platform / partner revenue" },
] as const;
export type RevenueLine = (typeof REVENUE_LINES)[number]["key"];

/**
 * Cash received per day and revenue line (money actually collected, voids
 * excluded). Owner/admin and finance see every line; RLS hides what a role
 * can't see.
 */
export async function dailyRevenue(
  tx: Parameters<ReportDef["run"]>[0],
  from: IsoDate,
  to: IsoDate,
  grain: "day" | "month" = "day",
): Promise<{ d: string; line: RevenueLine; amount: bigint }[]> {
  // grain "month": d is the first day of the month (fewer rows for long ranges).
  const g = (col: string) => (grain === "month" ? sql.raw(`date_trunc('month', ${col})::date::text`) : sql.raw(`${col}::text`));
  const rows = await tx.execute<{ d: string; line: RevenueLine; amount: string }>(sql`
    SELECT ${g("p.business_date")} AS d,
      (CASE a.kind WHEN 'boundary' THEN 'boundary' WHEN 'amortization' THEN 'rto' ELSE 'driver_costs' END) AS line,
      SUM(pl.amount_centavos)::text AS amount
    FROM public.payments p JOIN public.payment_lines pl ON pl.payment_id = p.id JOIN public.driver_accounts a ON a.id = pl.account_id
    WHERE p.business_date BETWEEN ${from}::date AND ${to}::date
      AND NOT EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id)
    GROUP BY 1, 2
    UNION ALL
    SELECT ${g("ap.received_on")},
      CASE t.service_line WHEN 'franchise' THEN 'franchise' WHEN 'activation' THEN 'activation' ELSE 'other_apps' END,
      SUM(ap.amount_centavos)::text
    FROM public.application_payments ap JOIN public.applications a ON a.id = ap.application_id JOIN public.application_types t ON t.key = a.type_key
    WHERE ap.received_on BETWEEN ${from}::date AND ${to}::date AND ap.voided_at IS NULL
    GROUP BY 1, 2
    UNION ALL
    SELECT ${g("received_on")}, 'commissions', SUM(amount_centavos)::text FROM public.commissions_received
    WHERE received_on BETWEEN ${from}::date AND ${to}::date AND voided_at IS NULL GROUP BY 1
    UNION ALL
    SELECT ${g("entry_date")}, 'platform', SUM(amount_centavos)::text FROM public.cash_transactions
    WHERE category = 'platform_revenue' AND entry_date BETWEEN ${from}::date AND ${to}::date AND voided_at IS NULL GROUP BY 1`);
  return rows.map((r) => ({ d: r.d, line: r.line, amount: BigInt(r.amount) }));
}

export const salesReport: ReportDef = {
  key: "sales",
  title: "Sales Report",
  description: "Revenue by service line and period (cash received: driver collections, application fees, commissions, platform revenue).",
  group: "Sales & CRM",
  roles: ["owner_admin", "finance"],
  defaultRange: "this_month",
  landscape: true,
  params: [{ key: "by", label: "Period", options: PERIODS, default: "day" }],
  columns: [
    { key: "period", label: "Period", type: "text" },
    ...REVENUE_LINES.map((l) => ({ key: l.key, label: l.label, type: "money" as const, total: true })),
    { key: "total", label: "Total", type: "money", total: true },
  ],
  async run(tx, { from, to, params }) {
    const by = params.by as GroupBy;
    const daily = await dailyRevenue(tx, from, to);
    const keys = REVENUE_LINES.map((l) => l.key);
    const g = groupSums(daily, (r) => bucketStart(r.d as IsoDate, by), keys, (r, f) => (r.line === f ? r.amount : ZERO));
    return {
      rows: bucketsBetween(from, to, by).map((b) => {
        const s = g.get(b)?.sums;
        const vals = Object.fromEntries(keys.map((k) => [k, s?.[k] ?? ZERO])) as Record<RevenueLine, bigint>;
        return { period: bucketLabel(b, by), ...vals, total: keys.reduce((t, k) => t + vals[k], ZERO) };
      }),
      notes: ["Cash basis: money received in the period. Voided payments excluded. Investor/owner capital, transfers and cash-advance returns are not revenue."],
    };
  },
};

const APP_GROUPS = [
  { value: "type", label: "Application type" },
  { value: "staff", label: "Staff (assigned)" },
];

export const applicationsReport: ReportDef = {
  key: "applications",
  title: "New Application / Activation Report",
  description: "Applications created, approved/activated, completed and cancelled, by type or staff, with fees billed and collected.",
  group: "Sales & CRM",
  roles: ["owner_admin", "operations", "sales", "documentation", "finance"],
  defaultRange: "this_month",
  params: [{ key: "by", label: "Group by", options: APP_GROUPS, default: "type" }],
  columns: (ctx) => [
    { key: "group", label: APP_GROUPS.find((g) => g.value === ctx.params.by)?.label ?? "Group", type: "text" },
    { key: "created", label: "Created", type: "int", total: true },
    { key: "approved", label: "Approved / activated", type: "int", total: true },
    { key: "completed", label: "Completed", type: "int", total: true },
    { key: "cancelled", label: "Cancelled", type: "int", total: true },
    { key: "billed", label: "Fees billed", type: "money", total: true },
    { key: "collected", label: "Fees collected", type: "money", total: true },
  ],
  async run(tx, { from, to, params }) {
    const groupExpr =
      params.by === "staff"
        ? sql`COALESCE((SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = a.assigned_to), 'Unassigned')`
        : sql`t.label`;
    const rows = await tx.execute<{ group: string; created: number; approved: number; completed: number; cancelled: number; billed: string; collected: string }>(sql`
      WITH x AS (
        SELECT ${groupExpr} AS grp, a.id, a.created_at, a.approved_at, a.completed_at, s.kind, a.status_changed_at
        FROM public.applications a JOIN public.application_types t ON t.key = a.type_key JOIN public.application_statuses s ON s.key = a.status_key
      )
      SELECT grp AS group,
        count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN ${from}::date AND ${to}::date)::int AS created,
        count(*) FILTER (WHERE (approved_at AT TIME ZONE 'Asia/Manila')::date BETWEEN ${from}::date AND ${to}::date)::int AS approved,
        count(*) FILTER (WHERE (completed_at AT TIME ZONE 'Asia/Manila')::date BETWEEN ${from}::date AND ${to}::date)::int AS completed,
        count(*) FILTER (WHERE kind = 'cancelled' AND (status_changed_at AT TIME ZONE 'Asia/Manila')::date BETWEEN ${from}::date AND ${to}::date)::int AS cancelled,
        COALESCE(SUM((SELECT SUM(f.amount_centavos) FROM public.application_fees f WHERE f.application_id = x.id AND f.voided_at IS NULL
          AND (f.created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN ${from}::date AND ${to}::date)), 0)::text AS billed,
        COALESCE(SUM((SELECT SUM(ap.amount_centavos) FROM public.application_payments ap WHERE ap.application_id = x.id AND ap.voided_at IS NULL
          AND ap.received_on BETWEEN ${from}::date AND ${to}::date)), 0)::text AS collected
      FROM x GROUP BY grp ORDER BY grp`);
    return {
      rows: rows
        .map((r) => ({ ...r, billed: BigInt(r.billed), collected: BigInt(r.collected) }))
        .filter((r) => r.created || r.approved || r.completed || r.cancelled || r.billed || r.collected),
      notes: ["Each column counts events in the period: an application created last month and approved this month counts as approved this month."],
    };
  },
};

const LEAD_GROUPS = [
  { value: "source", label: "Source" },
  { value: "stage", label: "Stage" },
  { value: "agent", label: "Agent" },
  { value: "interest", label: "Interest" },
];
const SOURCE_LABEL: Record<string, string> = {
  facebook_page: "Facebook page",
  messenger: "Messenger",
  fb_lead_ad: "Facebook Lead Ad",
  landing_page: "Website form",
  referral: "Referral",
  walk_in: "Walk-in",
  tiktok: "TikTok",
  other: "Other",
};

export const crmLeadsReport: ReportDef = {
  key: "crm-leads",
  title: "CRM Lead Report",
  description: "New leads by source, stage, agent or interest, and how many converted.",
  group: "Sales & CRM",
  roles: ["owner_admin", "operations", "sales"],
  defaultRange: "this_month",
  params: [{ key: "by", label: "Group by", options: LEAD_GROUPS, default: "source" }],
  columns: (ctx) => [
    { key: "group", label: LEAD_GROUPS.find((g) => g.value === ctx.params.by)?.label ?? "Group", type: "text" },
    { key: "leads", label: "New leads", type: "int", total: true },
    { key: "open", label: "Still open", type: "int", total: true },
    { key: "won", label: "Converted", type: "int", total: true },
    { key: "lost", label: "Lost", type: "int", total: true },
    { key: "conversion", label: "Conversion", type: "pct" },
  ],
  async run(tx, { from, to, params }) {
    const groupExpr =
      params.by === "stage"
        ? sql`s.label`
        : params.by === "agent"
          ? sql`COALESCE((SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = l.assigned_to), 'Unassigned')`
          : params.by === "interest"
            ? sql`l.interest::text`
            : sql`l.source::text`;
    const rows = await tx.execute<{ group: string; leads: number; open: number; won: number; lost: number }>(sql`
      SELECT ${groupExpr} AS group, count(*)::int AS leads,
        count(*) FILTER (WHERE s.kind = 'open')::int AS open, count(*) FILTER (WHERE s.kind = 'won')::int AS won,
        count(*) FILTER (WHERE s.kind = 'lost')::int AS lost
      FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key
      WHERE l.created_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Manila')
        AND l.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')
      GROUP BY 1 ORDER BY 2 DESC`);
    const total = rows.reduce((a, r) => ({ leads: a.leads + r.leads, won: a.won + r.won }), { leads: 0, won: 0 });
    return {
      rows: rows.map((r) => ({
        ...r,
        group: params.by === "source" ? (SOURCE_LABEL[r.group] ?? r.group) : r.group.replaceAll("_", " "),
        conversion: ratioBps(r.won, r.leads),
      })),
      totals: {
        group: "Total",
        leads: total.leads,
        open: rows.reduce((s, r) => s + r.open, 0),
        won: total.won,
        lost: rows.reduce((s, r) => s + r.lost, 0),
        conversion: ratioBps(total.won, total.leads),
      },
      notes: ["Leads created in the period, counted by where they are now. Conversion = converted ÷ new leads."],
    };
  },
};

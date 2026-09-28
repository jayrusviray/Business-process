import { sql } from "drizzle-orm";
import { categoryLabel, isNonOperating, summarizeFlows, type CashRow } from "@/lib/cashbook";
import type { IsoDate } from "@/lib/dates";
import { ZERO } from "@/lib/money";
import { breakdownOf } from "@/server/office/payroll";
import { investorStatementLines, renderInvestorStatementPdf } from "@/server/pdf/investor-statement";
import { cashBalancesAtMany, listCashAccounts } from "@/server/queries/cashbook";
import { payrollRegisterXlsx } from "@/server/xlsx/payroll-register";
import { payrollLines, payrollPeriods, employees } from "@/db/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { addDays } from "@/lib/dates";
import type { ReportDef } from "./types";

const FIN = ["owner_admin", "finance"] as const;

export const quotaBonusReport: ReportDef = {
  key: "quota-bonus",
  title: "Quota & Bonus Report",
  description: "Drivers who hit or missed each quota per period, and the bonuses paid (cash or credit).",
  group: "Collections",
  roles: ["owner_admin", "finance", "operations"],
  defaultRange: "last_month",
  columns: [
    { key: "period", label: "Period", type: "text" },
    { key: "rule", label: "Quota", type: "text" },
    { key: "driver", label: "Driver", type: "text" },
    { key: "value", label: "Result", type: "int" },
    { key: "threshold", label: "Target", type: "int" },
    { key: "hit", label: "Hit?", type: "text" },
    { key: "bonus", label: "Bonus", type: "money", total: true },
    { key: "mode", label: "Paid as", type: "text" },
    { key: "paid_on", label: "Paid on", type: "date" },
  ],
  async run(tx, { from, to }) {
    const rows = await tx.execute<{ period: string; rule: string; metric: string; driver: string; value: string; threshold: string; bonus: string | null; mode: string | null; paid_on: string | null }>(sql`
      SELECT r.period_start::text || ' – ' || r.period_end::text AS period, q.name AS rule, q.metric::text AS metric,
        d.last_name || ', ' || d.first_name AS driver, r.value::text, q.threshold::text,
        b.amount_centavos::text AS bonus, b.payout_mode::text AS mode, b.paid_on::text
      FROM public.quota_results r JOIN public.quota_rules q ON q.id = r.rule_id JOIN public.drivers d ON d.id = r.driver_id
      LEFT JOIN public.bonus_awards b ON b.quota_result_id = r.id AND b.voided_at IS NULL
      WHERE r.period_start <= ${to}::date AND r.period_end >= ${from}::date
      ORDER BY r.period_start, q.name, d.last_name`);
    const out = rows.map((r) => {
      const money = r.metric === "earnings_centavos";
      return {
        period: r.period,
        rule: r.rule,
        driver: r.driver,
        // Earnings targets are in centavos: shown in pesos (whole) so the column stays a count.
        value: money ? Number(BigInt(r.value) / BigInt(100)) : Number(r.value),
        threshold: money ? Number(BigInt(r.threshold) / BigInt(100)) : Number(r.threshold),
        hit: BigInt(r.value) >= BigInt(r.threshold) ? "Yes" : "No",
        bonus: r.bonus ? BigInt(r.bonus) : null,
        mode: r.mode === "credit" ? "Credit to balance" : r.mode === "cash" ? "Cash" : "",
        paid_on: r.paid_on,
      };
    });
    const hits = out.filter((r) => r.hit === "Yes").length;
    return { rows: out, notes: [`${hits} of ${out.length} results hit the target. Earnings targets are shown in whole pesos.`] };
  },
};

const EXPENSE_GROUPS = [
  { value: "category", label: "Category" },
  { value: "vendor", label: "Vendor" },
  { value: "vehicle", label: "Vehicle" },
  { value: "none", label: "Each expense" },
];

export const expenseReport: ReportDef = {
  key: "expenses",
  title: "Expense Report",
  description: "Expenses by category, vendor or vehicle (voided ones excluded).",
  group: "Office & finance",
  roles: FIN,
  defaultRange: "this_month",
  params: [{ key: "by", label: "Group by", options: EXPENSE_GROUPS, default: "category" }],
  columns: (ctx) =>
    ctx.params.by === "none"
      ? [
          { key: "date", label: "Date", type: "date" },
          { key: "category", label: "Category", type: "text" },
          { key: "vendor", label: "Vendor", type: "text" },
          { key: "description", label: "Description", type: "text" },
          { key: "vehicle", label: "Vehicle", type: "text" },
          { key: "paid_via", label: "Paid via", type: "text" },
          { key: "amount", label: "Amount", type: "money", total: true },
        ]
      : [
          { key: "group", label: EXPENSE_GROUPS.find((g) => g.value === ctx.params.by)?.label ?? "Group", type: "text" },
          { key: "count", label: "Expenses", type: "int", total: true },
          { key: "amount", label: "Amount", type: "money", total: true },
        ],
  async run(tx, { from, to, params }) {
    const base = sql`
      FROM public.expenses e JOIN public.expense_categories c ON c.id = e.category_id LEFT JOIN public.vehicles v ON v.id = e.vehicle_id
      WHERE e.voided_at IS NULL AND e.expense_date BETWEEN ${from}::date AND ${to}::date`;
    if (params.by === "none") {
      const rows = await tx.execute<{ date: string; category: string; vendor: string; description: string; vehicle: string | null; paid_via: string; amount: string }>(sql`
        SELECT e.expense_date::text AS date, c.name AS category, e.vendor, e.description, v.plate_no AS vehicle, replace(e.paid_via, '_', ' ') AS paid_via,
          e.amount_centavos::text AS amount ${base} ORDER BY e.expense_date, e.created_at`);
      return { rows: rows.map((r) => ({ ...r, amount: BigInt(r.amount) })) };
    }
    const grp = params.by === "vendor" ? sql`COALESCE(NULLIF(e.vendor, ''), '(no vendor)')` : params.by === "vehicle" ? sql`COALESCE(v.plate_no, '(no vehicle)')` : sql`c.name`;
    const rows = await tx.execute<{ group: string; count: number; amount: string }>(sql`
      SELECT ${grp} AS group, count(*)::int AS count, SUM(e.amount_centavos)::text AS amount ${base} GROUP BY 1 ORDER BY SUM(e.amount_centavos) DESC`);
    return {
      rows: rows.map((r) => ({ ...r, amount: BigInt(r.amount) })),
      notes: ["Includes payroll cost (gross + employer contributions) and spending out of cash advances, which are real expenses even though the cash book counts the advance when it was given."],
    };
  },
};

const REGISTER = [
  ["grossTaxable", "Gross taxable"],
  ["nonTaxable", "Non-taxable"],
  ["govEmployee", "SSS/PhilHealth/Pag-IBIG (EE)"],
  ["withholdingTax", "Withholding tax"],
  ["cashAdvanceDeduction", "Cash advance"],
  ["otherDeductions", "Other deductions"],
  ["netPay", "Net pay"],
  ["employer", "Employer contributions"],
] as const;

export const payrollRegisterReport: ReportDef = {
  key: "payroll-register",
  title: "Payroll Register",
  description: "Per payroll run: earnings, deductions, net pay and employer contributions. Excel export of a single run is the official register.",
  group: "Office & finance",
  roles: FIN,
  defaultRange: "this_year",
  landscape: true,
  params: [
    {
      key: "period",
      label: "Payroll run",
      default: "",
      options: async (tx) => [
        { value: "", label: "All runs paid in the range" },
        ...(await tx
          .select({ id: payrollPeriods.id, start: payrollPeriods.periodStart, end: payrollPeriods.periodEnd, status: payrollPeriods.status })
          .from(payrollPeriods)
          .orderBy(asc(payrollPeriods.periodStart))).map((p) => ({ value: p.id, label: `${p.start} – ${p.end} (${p.status})` })),
      ],
    },
  ],
  columns: [
    { key: "period", label: "Period", type: "text" },
    { key: "employee", label: "Employee", type: "text" },
    ...REGISTER.map(([k, l]) => ({ key: k, label: l, type: "money" as const, total: true })),
  ],
  async run(tx, { from, to, params }) {
    const rows = await tx
      .select({ l: payrollLines, e: employees, p: payrollPeriods })
      .from(payrollLines)
      .innerJoin(employees, eq(employees.id, payrollLines.employeeId))
      .innerJoin(payrollPeriods, eq(payrollPeriods.id, payrollLines.periodId))
      .where(params.period ? eq(payrollPeriods.id, params.period) : and(gte(payrollPeriods.payDate, from), lte(payrollPeriods.payDate, to)))
      .orderBy(asc(payrollPeriods.periodStart), asc(employees.lastName));
    return {
      rows: rows.map(({ l, e, p }) => {
        const b = breakdownOf(l);
        const v = (k: string) => b[k] ?? ZERO;
        return {
          period: `${p.periodStart} – ${p.periodEnd}${p.status === "draft" ? " (draft)" : ""}`,
          employee: `${e.lastName}, ${e.firstName}`,
          grossTaxable: v("grossTaxable"),
          nonTaxable: v("nonTaxable"),
          govEmployee: v("sssEmployee") + v("philhealthEmployee") + v("pagibigEmployee"),
          withholdingTax: v("withholdingTax"),
          cashAdvanceDeduction: v("cashAdvanceDeduction"),
          otherDeductions: v("otherDeductions"),
          netPay: v("netPay"),
          employer: v("sssEmployer") + v("sssEc") + v("philhealthEmployer") + v("pagibigEmployer"),
        };
      }),
    };
  },
  async xlsx(tx, { params }) {
    if (!params.period) return null;
    const data = await payrollRegisterXlsx(tx, params.period);
    return data ? { data, filename: "payroll-register.xlsx" } : null;
  },
};

const COMMISSION_STATUS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved (to pay)" },
  { value: "paid", label: "Paid / received" },
  { value: "void", label: "Void" },
];

export const commissionReport: ReportDef = {
  key: "commissions",
  title: "Commission Report",
  description: "Referral commissions (drivers and applications) pending, approved and paid, and commissions received from platforms and dealers.",
  group: "Office & finance",
  roles: FIN,
  defaultRange: "this_month",
  params: [{ key: "status", label: "Status", options: COMMISSION_STATUS, default: "" }],
  columns: [
    { key: "kind", label: "Kind", type: "text" },
    { key: "date", label: "Date", type: "date" },
    { key: "party", label: "Referrer / from", type: "text" },
    { key: "about", label: "For", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "payable", label: "To pay", type: "money", total: true },
    { key: "received", label: "Received", type: "money", total: true },
  ],
  async run(tx, { from, to, params }) {
    const rows = await tx.execute<{ kind: string; date: string; party: string; about: string; status: string; amount: string; direction: string }>(sql`
      SELECT 'Driver referral' AS kind, COALESCE(rc.paid_on, rc.payable_on)::text AS date, rc.referrer_name AS party, c.contract_no AS about,
        rc.status::text AS status, rc.amount_centavos::text AS amount, 'out' AS direction
      FROM public.referral_commissions rc JOIN public.rto_contracts c ON c.id = rc.rto_contract_id
      WHERE COALESCE(rc.paid_on, rc.payable_on) BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT 'Application referral', COALESCE(ac.paid_on, (ac.created_at AT TIME ZONE 'Asia/Manila')::date)::text, ac.referrer_name, a.app_no,
        ac.status::text, ac.amount_centavos::text, 'out'
      FROM public.application_commissions ac JOIN public.applications a ON a.id = ac.application_id
      WHERE COALESCE(ac.paid_on, (ac.created_at AT TIME ZONE 'Asia/Manila')::date) BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT 'Received (' || cr.source_type || ')', cr.received_on::text, cr.counterparty, cr.description,
        CASE WHEN cr.voided_at IS NULL THEN 'paid' ELSE 'void' END, cr.amount_centavos::text, 'in'
      FROM public.commissions_received cr
      WHERE cr.received_on BETWEEN ${from}::date AND ${to}::date
      ORDER BY 2, 1`);
    return {
      rows: rows
        .filter((r) => !params.status || r.status === params.status)
        .map((r) => ({
          kind: r.kind,
          date: r.date,
          party: r.party,
          about: r.about,
          status: r.direction === "in" ? (r.status === "void" ? "void" : "received") : r.status,
          payable: r.direction === "out" && r.status !== "void" ? BigInt(r.amount) : null,
          received: r.direction === "in" && r.status !== "void" ? BigInt(r.amount) : null,
        })),
      notes: ["Dates: paid date when paid, otherwise the payable date (driver referrals) or creation date (application referrals). Void rows show no amount."],
    };
  },
};

export const investorStatementReport: ReportDef = {
  key: "investor-statement",
  title: "Investor Statement",
  description: "Per investor per month: each vehicle's share (22 × daily boundary − the driver's monthly RTO amortization) and what was paid. The PDF is the statement for the investor.",
  group: "Office & finance",
  roles: FIN,
  defaultRange: "last_month",
  landscape: true,
  params: [
    {
      key: "investor",
      label: "Investor",
      default: "",
      options: async (tx) => [
        { value: "", label: "All investors" },
        ...(await tx.execute<{ value: string; label: string }>(sql`SELECT id::text AS value, name AS label FROM public.investors ORDER BY name`)),
      ],
    },
  ],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "investor", label: "Investor", type: "text" },
    { key: "vehicle", label: "Vehicle", type: "text" },
    { key: "driver", label: "Driver", type: "text" },
    { key: "gross", label: "Days × daily boundary", type: "money", total: true },
    { key: "amortization", label: "Less RTO amortization", type: "money", total: true },
    { key: "share", label: "Share", type: "money", total: true },
    { key: "paid", label: "Paid", type: "money", total: true },
    { key: "status", label: "Status", type: "text" },
  ],
  async run(tx, { from, to, params }) {
    const lines = await investorStatementLines(tx, { investorId: params.investor || null, from, to });
    const negative = lines.filter((l) => BigInt(l.computed) < ZERO);
    return {
      rows: lines.map((l) => ({
        month: l.month.slice(0, 7),
        investor: l.investor,
        vehicle: l.plate_no,
        driver: l.driver ?? "no driver",
        gross: BigInt(l.daily_rate) * BigInt(l.boundary_days),
        amortization: BigInt(l.amortization),
        share: BigInt(l.payable),
        paid: l.status === "paid" ? BigInt(l.payable) : ZERO,
        status: l.status === "paid" ? `paid ${l.paid_on ?? ""}${l.reference ? ` (${l.reference})` : ""}` : "pending",
      })),
      notes: [
        "Owner model: no percentage split, deductions or management fee. Rows are the computed monthly payouts (Investors screen).",
        ...(negative.length ? [`${negative.length} vehicle-month(s) came out negative and are paid as ₱0.00 (flagged for review).`] : []),
      ],
    };
  },
  async pdf(tx, { from, to, params }) {
    const data = await renderInvestorStatementPdf(tx, { investorId: params.investor || null, from, to });
    return data ? { data, filename: `investor-statement-${from.slice(0, 7)}.pdf` } : null;
  },
};

const FLOW_GROUPS = [
  { value: "category", label: "Category" },
  { value: "account", label: "Account" },
  { value: "month", label: "Month" },
];

export const cashFlowReport: ReportDef = {
  key: "cash-flow",
  title: "Cash Flow Report",
  description: "All money in and out by category, account or month, from the cash book.",
  group: "Office & finance",
  roles: FIN,
  defaultRange: "this_month",
  params: [{ key: "by", label: "Group by", options: FLOW_GROUPS, default: "category" }],
  columns: (ctx) => [
    { key: "group", label: FLOW_GROUPS.find((g) => g.value === ctx.params.by)?.label ?? "Group", type: "text" },
    ...(ctx.params.by === "account" ? [{ key: "opening", label: "Opening", type: "money" as const, total: true }] : []),
    { key: "in", label: "In", type: "money", total: true },
    { key: "out", label: "Out", type: "money", total: true },
    { key: "net", label: "Net", type: "money", total: true },
    ...(ctx.params.by === "account" ? [{ key: "closing", label: "Closing", type: "money" as const, total: true }] : []),
  ],
  async run(tx, { from, to, params }) {
    const agg = await tx.execute<{ m: string; category: string; account_id: string | null; direction: "in" | "out"; amount: string; last: Date }>(sql`
      SELECT to_char(entry_date, 'YYYY-MM') AS m, category, account_id, direction, SUM(amount_centavos)::text AS amount, max(created_at) AS last
      FROM public.v_cash_book WHERE entry_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2, 3, 4`);
    const rows: (CashRow & { m: string })[] = agg.map((r, i) => ({
      m: r.m,
      sourceType: "aggregate",
      sourceId: String(i),
      lineKey: "",
      entryDate: `${r.m}-01` as IsoDate,
      direction: r.direction,
      amount: BigInt(r.amount),
      category: r.category,
      accountId: r.account_id,
      createdAt: r.last,
    }));
    const notes = ["Totals leave out transfers between our own accounts and opening balances (they don't change what the business has)."];
    if (params.by === "account") {
      const [accounts, [before, after]] = await Promise.all([listCashAccounts(tx), cashBalancesAtMany(tx, [addDays(from, -1), to])]);
      const flows = summarizeFlows(rows).byAccount;
      return {
        rows: accounts.map((a) => {
          const f = flows.get(a.id) ?? { in: ZERO, out: ZERO };
          return { group: a.name, opening: before.get(a.id) ?? ZERO, in: f.in, out: f.out, net: f.in - f.out, closing: after.get(a.id) ?? ZERO };
        }),
        notes: ["Per account, transfers and opening balances are included (they move money between accounts)."],
      };
    }
    if (params.by === "month") {
      const months = [...new Set(rows.map((r) => r.m))].sort();
      return {
        rows: months.map((m) => {
          const s = summarizeFlows(rows.filter((r) => r.m === m));
          return { group: m, in: s.totalIn, out: s.totalOut, net: s.net };
        }),
        notes,
      };
    }
    const s = summarizeFlows(rows);
    return {
      rows: [...s.byCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .sort(([, a], [, b]) => (b.in > ZERO ? 1 : 0) - (a.in > ZERO ? 1 : 0))
        .map(([c, v]) => ({ group: `${categoryLabel(c)}${isNonOperating(c) ? " (not in totals)" : ""}`, in: v.in, out: v.out, net: v.in - v.out })),
      totals: { group: "Total", in: s.totalIn, out: s.totalOut, net: s.net },
      notes,
    };
  },
};

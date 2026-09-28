import type { IsoDate } from "./dates";
import { ZERO, type Centavos } from "./money";

/**
 * Cash book math (spec 4.15). Rows come from the `v_cash_book` view; every
 * function here is pure. A balance is always opening + SUM(signed rows); it is
 * never stored.
 */

export type CashDirection = "in" | "out";

export const CASH_CATEGORY_LABELS: Record<string, string> = {
  // in
  boundary: "Boundary",
  rto: "RTO / amortization (incl. cashouts)",
  driver_charges: "Driver costs & deposits",
  documentation_fees: "Documentation & activation fees",
  commission_received: "Commissions received",
  platform_revenue: "Platform / partner revenue",
  investor_capital: "Investor capital",
  owner_capital: "Owner capital",
  other_in: "Other money in",
  cash_advance_return: "Cash advances returned",
  opening_balance: "Opening balance",
  transfer_in: "Transfer in",
  // out
  payroll: "Payroll",
  expense: "Expenses",
  commission_payout: "Commission payouts",
  investor_payout: "Investor payouts",
  loan_amortization: "Vehicle loan amortization",
  cash_advance: "Cash advances given",
  driver_bonus: "Driver bonuses (cash)",
  owner_withdrawal: "Owner withdrawals",
  other_out: "Other money out",
  transfer_out: "Transfer out",
};

export const CASH_IN_CATEGORIES = [
  "boundary",
  "rto",
  "driver_charges",
  "documentation_fees",
  "commission_received",
  "platform_revenue",
  "investor_capital",
  "owner_capital",
  "other_in",
  "cash_advance_return",
  "opening_balance",
  "transfer_in",
] as const;

export const CASH_OUT_CATEGORIES = [
  "payroll",
  "expense",
  "commission_payout",
  "investor_payout",
  "loan_amortization",
  "cash_advance",
  "driver_bonus",
  "owner_withdrawal",
  "other_out",
  "transfer_out",
] as const;

/** Manual entry categories offered on the form, with their direction. */
export const MANUAL_CATEGORIES: { value: string; label: string; direction: CashDirection }[] = [
  { value: "platform_revenue", label: "Platform / partner revenue", direction: "in" },
  { value: "investor_capital", label: "Investor capital", direction: "in" },
  { value: "owner_capital", label: "Owner capital", direction: "in" },
  { value: "other_in", label: "Other money in", direction: "in" },
  { value: "opening_balance", label: "Opening balance", direction: "in" },
  { value: "owner_withdrawal", label: "Owner withdrawal", direction: "out" },
  { value: "other_out", label: "Other money out", direction: "out" },
];

/**
 * Movements that don't change how much money the business has: transfers
 * between its own accounts, and opening balances (money it already had).
 * They count in account balances but not in period inflow/outflow totals.
 */
export function isNonOperating(category: string): boolean {
  return category === "transfer_in" || category === "transfer_out" || category === "opening_balance";
}

export function categoryLabel(category: string): string {
  return CASH_CATEGORY_LABELS[category] ?? category;
}

export type CashRow = {
  sourceType: string;
  sourceId: string;
  lineKey: string;
  entryDate: IsoDate;
  direction: CashDirection;
  amount: Centavos;
  category: string;
  accountId: string | null;
  /** Insertion time, used to order rows within a day. */
  createdAt: Date | string;
};

export function signed(r: Pick<CashRow, "direction" | "amount">): Centavos {
  return r.direction === "in" ? r.amount : -r.amount;
}

const time = (v: Date | string) => (typeof v === "string" ? new Date(v).getTime() : v.getTime());

/** Book order: date, then time recorded, then a stable key. */
export function compareCashRows(a: CashRow, b: CashRow): number {
  if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
  const ta = time(a.createdAt);
  const tb = time(b.createdAt);
  if (ta !== tb) return ta - tb;
  const ka = `${a.sourceType}:${a.sourceId}:${a.lineKey}`;
  const kb = `${b.sourceType}:${b.sourceId}:${b.lineKey}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export const UNASSIGNED = "unassigned";

/**
 * Adds each row's account balance after the row. `opening` = balance per
 * account before the first row (rows before the period). Rows are put in book
 * order first; the input is not modified.
 */
export function withRunningBalances<R extends CashRow>(
  opening: ReadonlyMap<string, Centavos>,
  rows: readonly R[],
): { rows: (R & { balanceAfter: Centavos })[]; closing: Map<string, Centavos> } {
  const bal = new Map(opening);
  const out = [...rows].sort(compareCashRows).map((r) => {
    const key = r.accountId ?? UNASSIGNED;
    const next = (bal.get(key) ?? ZERO) + signed(r);
    bal.set(key, next);
    return { ...r, balanceAfter: next };
  });
  return { rows: out, closing: bal };
}

export type FlowSummary = {
  totalIn: Centavos;
  totalOut: Centavos;
  net: Centavos;
  transfersIn: Centavos;
  transfersOut: Centavos;
  openingBalances: Centavos;
  byCategory: Map<string, { in: Centavos; out: Centavos; count: number }>;
  byAccount: Map<string, { in: Centavos; out: Centavos }>;
};

/**
 * Period inflow/outflow. Totals and net exclude transfers and opening balances
 * (see isNonOperating); those are reported separately and still count per account.
 */
export function summarizeFlows(rows: readonly CashRow[]): FlowSummary {
  const s: FlowSummary = {
    totalIn: ZERO,
    totalOut: ZERO,
    net: ZERO,
    transfersIn: ZERO,
    transfersOut: ZERO,
    openingBalances: ZERO,
    byCategory: new Map(),
    byAccount: new Map(),
  };
  for (const r of rows) {
    const c = s.byCategory.get(r.category) ?? { in: ZERO, out: ZERO, count: 0 };
    const a = s.byAccount.get(r.accountId ?? UNASSIGNED) ?? { in: ZERO, out: ZERO };
    if (r.direction === "in") {
      c.in += r.amount;
      a.in += r.amount;
    } else {
      c.out += r.amount;
      a.out += r.amount;
    }
    c.count += 1;
    s.byCategory.set(r.category, c);
    s.byAccount.set(r.accountId ?? UNASSIGNED, a);
    if (r.category === "transfer_in") s.transfersIn += r.amount;
    else if (r.category === "transfer_out") s.transfersOut += r.amount;
    else if (r.category === "opening_balance") s.openingBalances += r.amount;
    else if (r.direction === "in") s.totalIn += r.amount;
    else s.totalOut += r.amount;
  }
  s.net = s.totalIn - s.totalOut;
  return s;
}

/** Counted minus book balance: negative = money missing, positive = more than the books show. */
export function reconciliationVariance(counted: Centavos, system: Centavos): Centavos {
  return counted - system;
}

/** Month-end dates (inclusive) from `from` to `to`, e.g. for "reconciled every month?" checks. */
export function monthEndsBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let [y, m] = from.split("-").map(Number);
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) as IsoDate;
    if (end > to) break;
    if (end >= from) out.push(end);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Display helper: with hundreds of driver payments a day, show one line per
 * day, account and category ("Boundary · 482 payments"). Each collapsed line
 * takes the position and running balance of its last payment, so the balances
 * shown stay exact. Other rows are kept as they are. Input must be in book order.
 */
export function collapseDriverPayments<R extends CashRow & { balanceAfter: Centavos }>(rows: readonly R[]): (R & { count: number })[] {
  const lastIndex = new Map<string, number>();
  const groupKey = (r: R) => `${r.entryDate}|${r.accountId ?? UNASSIGNED}|${r.category}`;
  rows.forEach((r, i) => {
    if (r.sourceType === "payment") lastIndex.set(groupKey(r), i);
  });
  const sums = new Map<string, { amount: Centavos; count: number }>();
  const out: (R & { count: number })[] = [];
  rows.forEach((r, i) => {
    if (r.sourceType !== "payment") {
      out.push({ ...r, count: 1 });
      return;
    }
    const k = groupKey(r);
    const s = sums.get(k) ?? { amount: ZERO, count: 0 };
    s.amount += r.amount;
    s.count += 1;
    sums.set(k, s);
    if (lastIndex.get(k) === i) out.push({ ...r, amount: s.amount, count: s.count });
  });
  return out;
}

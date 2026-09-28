import { asc, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { cashAccounts } from "@/db/schema";
import type { CashDirection, CashRow } from "@/lib/cashbook";
import type { IsoDate } from "@/lib/dates";

export type CashAccountRow = typeof cashAccounts.$inferSelect;

export async function listCashAccounts(tx: Tx): Promise<CashAccountRow[]> {
  return tx.select().from(cashAccounts).orderBy(asc(cashAccounts.sort), asc(cashAccounts.name));
}

export type CashBookRow = CashRow & {
  subcategory: string;
  method: string | null;
  counterparty: string;
  description: string;
  reference: string;
  reassigned: boolean;
};

type RawRow = {
  source_type: string;
  source_id: string;
  line_key: string;
  entry_date: string;
  direction: CashDirection;
  amount_centavos: string;
  category: string;
  subcategory: string;
  method: string | null;
  counterparty: string;
  description: string;
  reference: string;
  account_id: string | null;
  reassigned: boolean;
  created_at: Date;
};

const toRow = (r: RawRow): CashBookRow => ({
  sourceType: r.source_type,
  sourceId: r.source_id,
  lineKey: r.line_key,
  entryDate: r.entry_date as IsoDate,
  direction: r.direction,
  amount: BigInt(r.amount_centavos),
  category: r.category,
  subcategory: r.subcategory,
  method: r.method,
  counterparty: r.counterparty,
  description: r.description,
  reference: r.reference,
  accountId: r.account_id,
  reassigned: r.reassigned,
  createdAt: r.created_at,
});

export type CashFilter = { from: IsoDate; to: IsoDate; accountId?: string | null; category?: string | null; direction?: CashDirection | null };

/** Cash book rows in a date range (owner/admin + finance; the view enforces it). */
export async function cashBookRows(tx: Tx, f: CashFilter): Promise<CashBookRow[]> {
  const rows = await tx.execute<RawRow>(sql`
    SELECT source_type, source_id, line_key, entry_date::text, direction, amount_centavos::text, category, subcategory, method,
      counterparty, description, reference, account_id, reassigned, created_at
    FROM public.v_cash_book
    WHERE entry_date BETWEEN ${f.from}::date AND ${f.to}::date
      AND ${f.accountId ? sql`account_id = ${f.accountId}::uuid` : sql`true`}
      AND ${f.category ? sql`category = ${f.category}` : sql`true`}
      AND ${f.direction ? sql`direction = ${f.direction}` : sql`true`}
    ORDER BY entry_date, created_at, source_type, source_id, line_key`);
  return rows.map(toRow);
}

/** Book balance of every account at the END of `date` (entries dated on or before it). */
export async function cashBalancesAt(tx: Tx, date: IsoDate): Promise<Map<string, bigint>> {
  return (await cashBalancesAtMany(tx, [date]))[0];
}

/** Balances at the end of several dates in one pass over the book (e.g. before a period and today). */
export async function cashBalancesAtMany(tx: Tx, dates: IsoDate[]): Promise<Map<string, bigint>[]> {
  const cols = dates.map((d, i) => sql`COALESCE(SUM(signed_centavos) FILTER (WHERE entry_date <= ${d}::date), 0)::text AS ${sql.raw(`b${i}`)}`);
  const rows = await tx.execute<Record<string, string | null>>(sql`
    SELECT account_id, ${sql.join(cols, sql`, `)} FROM public.v_cash_movements GROUP BY account_id`);
  return dates.map((_, i) => new Map(rows.map((r) => [r.account_id ?? "unassigned", BigInt(r[`b${i}`] ?? "0")])));
}

export type ReconciliationRow = {
  id: string;
  account_id: string;
  as_of_date: string;
  counted: string;
  system: string;
  notes: string;
  created_at: Date;
  by: string | null;
};

/** Reconciliations whose as-of date falls in the range (newest recount first per day). */
export async function reconciliationsBetween(tx: Tx, from: IsoDate, to: IsoDate): Promise<ReconciliationRow[]> {
  return tx.execute<ReconciliationRow>(sql`
    SELECT r.id, r.account_id, r.as_of_date::text, r.counted_centavos::text AS counted, r.system_centavos::text AS system, r.notes, r.created_at,
      (SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = r.created_by) AS by
    FROM public.cash_reconciliations r
    WHERE r.as_of_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY r.as_of_date DESC, r.created_at DESC`);
}

/** The latest reconciliation of each account, with the book balance for that day as it stands now. */
export async function latestReconciliations(tx: Tx): Promise<(ReconciliationRow & { live: string })[]> {
  return tx.execute<ReconciliationRow>(sql`
    SELECT DISTINCT ON (r.account_id) r.id, r.account_id, r.as_of_date::text, r.counted_centavos::text AS counted,
      r.system_centavos::text AS system, r.notes, r.created_at,
      (SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = r.created_by) AS by
    FROM public.cash_reconciliations r
    ORDER BY r.account_id, r.as_of_date DESC, r.created_at DESC`).then(async (latest) => {
    if (latest.length === 0) return [];
    // The book balance for each reconciled day as it stands now (one pass).
    const live = await tx.execute<{ account_id: string; live: string }>(sql`
      WITH r(account_id, as_of) AS (VALUES ${sql.join(latest.map((l) => sql`(${l.account_id}::uuid, ${l.as_of_date}::date)`), sql`, `)})
      SELECT r.account_id, COALESCE(SUM(m.signed_centavos) FILTER (WHERE m.entry_date <= r.as_of), 0)::text AS live
      FROM r LEFT JOIN public.v_cash_movements m ON m.account_id = r.account_id GROUP BY r.account_id`);
    return latest.map((l) => ({ ...l, live: live.find((x) => x.account_id === l.account_id)?.live ?? "0" }));
  });
}

/** Cash received by collectors that hasn't been handed to the office yet (shown next to Cash on hand). */
export async function unremittedCash(tx: Tx): Promise<bigint> {
  const [r] = await tx.execute<{ total: string }>(sql`SELECT COALESCE(SUM(amount_centavos), 0)::text AS total FROM public.v_unremitted_cash`);
  return BigInt(r?.total ?? "0");
}

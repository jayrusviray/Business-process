import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./foundation";

/**
 * Cash book (spec 4.15, milestone M-D). Every peso that comes in or goes out,
 * per money account (cash on hand, GCash, Maya, bank…).
 *
 * Nothing here stores a balance. The read model `v_cash_book` (migration
 * cashbook_security) unions the module records (driver payments, fee payments,
 * expenses, payroll, loans, commissions, investor payouts, cash advances…) with
 * the manual `cash_transactions` below; a balance is always a SUM over it.
 * See docs/notes-m-d.md for how each source maps to a category and account.
 */

export const CASH_ACCOUNT_KINDS = ["cash", "ewallet", "bank", "other"] as const;
export type CashAccountKind = (typeof CASH_ACCOUNT_KINDS)[number];

/** Payment methods a cash account can receive by default (payments.method / expenses.paid_via). */
export const ROUTABLE_METHODS = ["cash", "gcash", "maya", "bank_transfer", "other"] as const;
export type RoutableMethod = (typeof ROUTABLE_METHODS)[number];

/** Categories of manual entries. A transfer moves money between two of our own accounts. */
export const CASH_TXN_CATEGORIES = [
  "opening_balance",
  "platform_revenue",
  "investor_capital",
  "owner_capital",
  "other_in",
  "owner_withdrawal",
  "other_out",
  "transfer",
] as const;
export type CashTxnCategory = (typeof CASH_TXN_CATEGORIES)[number];

/** Module records that can be moved to another account (see cash_reassignments). */
export const REASSIGNABLE_SOURCES = [
  "payment",
  "application_payment",
  "commission_received",
  "referral_commission",
  "application_commission",
  "investor_payout",
  "loan_payment",
  "expense",
  "cash_advance",
  "cash_advance_settlement",
  "bonus_award",
] as const;
export type ReassignableSource = (typeof REASSIGNABLE_SOURCES)[number];

const created = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => profiles.id),
});

/**
 * Where money is kept. `payment_method`: records paid with this method land in
 * this account unless moved (one account per method). The opening balance is a
 * dated `cash_transactions` row, never a stored number.
 */
export const cashAccounts = pgTable(
  "cash_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind").$type<CashAccountKind>().notNull(),
    paymentMethod: text("payment_method").$type<RoutableMethod>(),
    active: boolean("active").notNull().default(true),
    sort: integer("sort").notNull().default(100),
    notes: text("notes").notNull().default(""),
    ...created(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    uniqueIndex("cash_accounts_name_uq").on(sql`lower(${t.name})`),
    uniqueIndex("cash_accounts_method_uq").on(t.paymentMethod),
    check("cash_accounts_kind", sql`${t.kind} IN ('cash', 'ewallet', 'bank', 'other')`),
    check("cash_accounts_method", sql`${t.paymentMethod} IS NULL OR ${t.paymentMethod} IN ('cash', 'gcash', 'maya', 'bank_transfer', 'other')`),
    check("cash_accounts_name_nonblank", sql`btrim(${t.name}) <> ''`),
  ],
);

/**
 * Money movements no module records: opening balances, platform/partner
 * revenue, investor or owner capital, owner withdrawals, other in/out, and
 * transfers between our own accounts (one row, shown as two legs). Void-only.
 */
export const cashTransactions = pgTable(
  "cash_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryDate: date("entry_date").notNull(),
    category: text("category").$type<CashTxnCategory>().notNull(),
    /** The account the money is in (in), leaves (out), or is transferred from (transfer). */
    accountId: uuid("account_id")
      .notNull()
      .references(() => cashAccounts.id),
    /** Transfers only: the account that receives the money. */
    counterAccountId: uuid("counter_account_id").references(() => cashAccounts.id),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    description: text("description").notNull(),
    counterparty: text("counterparty").notNull().default(""),
    reference: text("reference").notNull().default(""),
    ...created(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("cash_transactions_date_idx").on(t.entryDate),
    check("cash_transactions_amount_pos", sql`${t.amountCentavos} > 0`),
    check(
      "cash_transactions_category",
      sql`${t.category} IN ('opening_balance', 'platform_revenue', 'investor_capital', 'owner_capital', 'other_in', 'owner_withdrawal', 'other_out', 'transfer')`,
    ),
    check(
      "cash_transactions_transfer_pair",
      sql`(${t.category} = 'transfer') = (${t.counterAccountId} IS NOT NULL) AND ${t.counterAccountId} IS DISTINCT FROM ${t.accountId}`,
    ),
    check("cash_transactions_description", sql`btrim(${t.description}) <> ''`),
  ],
);

/**
 * A count of an account on a date (monthly reconciliation marker). Immutable:
 * `system_centavos` is the book balance at that moment, filled in by the
 * database; a recount is a new row.
 */
export const cashReconciliations = pgTable(
  "cash_reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => cashAccounts.id),
    asOfDate: date("as_of_date").notNull(),
    countedCentavos: bigint("counted_centavos", { mode: "bigint" }).notNull(),
    systemCentavos: bigint("system_centavos", { mode: "bigint" }).notNull(),
    notes: text("notes").notNull().default(""),
    ...created(),
  },
  (t) => [index("cash_reconciliations_account_idx").on(t.accountId, t.asOfDate)],
);

/**
 * Moves one module record (e.g. a loan payment that was paid from GCash, not
 * the default account) to another cash account. Append-only; the latest row
 * per record wins. The record itself is never changed.
 */
export const cashReassignments = pgTable(
  "cash_reassignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: text("source_type").$type<ReassignableSource>().notNull(),
    sourceId: uuid("source_id").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => cashAccounts.id),
    reason: text("reason").notNull(),
    ...created(),
  },
  (t) => [
    index("cash_reassignments_source_idx").on(t.sourceType, t.sourceId, t.createdAt),
    check(
      "cash_reassignments_source",
      sql`${t.sourceType} IN ('payment', 'application_payment', 'commission_received', 'referral_commission', 'application_commission',
        'investor_payout', 'loan_payment', 'expense', 'cash_advance', 'cash_advance_settlement', 'bonus_award')`,
    ),
    check("cash_reassignments_reason", sql`btrim(${t.reason}) <> ''`),
  ],
);

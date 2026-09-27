import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  date,
  index,
  integer,
  pgTable,
  pgSequence,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountKind, chargeRunStatus, ledgerEntryType, paymentMethod, programType } from "./enums";
import { drivers, vehicles } from "./fleet";
import { documents, profiles } from "./foundation";

/** One obligation stream per driver (see accountKind). */
export const driverAccounts = pgTable(
  "driver_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    kind: accountKind("kind").notNull(),
    /** Set for amortization accounts (FK added with RTO contracts in Phase 4). */
    contractId: uuid("contract_id"),
    openedOn: date("opened_on").notNull(),
    closedOn: date("closed_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [
    index("driver_accounts_driver_idx").on(t.driverId),
    // A driver has exactly one boundary account and one charges account.
    uniqueIndex("driver_accounts_single_uq")
      .on(t.driverId, t.kind)
      .where(sql`${t.kind} IN ('boundary', 'charges')`),
    uniqueIndex("driver_accounts_contract_uq").on(t.contractId),
  ],
);

/**
 * Boundary plan (follows the driver). Versioned: a rate change ends the current
 * plan and starts a new one. Only `effective_to` may be updated after creation.
 */
export const boundaryPlans = pgTable(
  "boundary_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => driverAccounts.id),
    programType: programType("program_type").notNull(),
    dailyRateCentavos: bigint("daily_rate_centavos", { mode: "bigint" }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** Inclusive last chargeable day; null = open-ended. */
    effectiveTo: date("effective_to"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    index("boundary_plans_driver_idx").on(t.driverId),
    check("boundary_plans_rate_pos", sql`${t.dailyRateCentavos} > 0`),
    check("boundary_plans_dates", sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

export const paymentReceiptSeq = pgSequence("payment_receipt_seq", { startWith: 1 });

/** Collector payments. Immutable; voids are recorded in payment_voids. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Acknowledgement receipt number, e.g. AR-000123 (owner: acknowledgement receipts only). */
    receiptNo: text("receipt_no")
      .notNull()
      .unique()
      .default(sql`('AR-' || lpad(nextval('payment_receipt_seq')::text, 6, '0'))`),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    method: paymentMethod("method").notNull(),
    referenceNo: text("reference_no"),
    bankName: text("bank_name"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    businessDate: date("business_date").notNull(),
    /** Staff member who physically received the money. */
    collectorId: uuid("collector_id")
      .notNull()
      .references(() => profiles.id),
    receiptDocumentId: uuid("receipt_document_id").references(() => documents.id),
    notes: text("notes").notNull().default(""),
    /** Idempotency key from the client form, so double-submits never double-post. */
    clientRequestId: uuid("client_request_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [
    index("payments_driver_idx").on(t.driverId, t.businessDate),
    index("payments_collector_idx").on(t.collectorId, t.businessDate),
    check("payments_amount_pos", sql`${t.amountCentavos} > 0`),
    check("payments_reference_required", sql`${t.method} = 'cash' OR coalesce(${t.referenceNo}, '') <> ''`),
  ],
);

/**
 * Append-only ledger. Positive = driver owes more, negative = driver owes less.
 * Balance of an account = SUM(amount_centavos). See CLAUDE.md "Money rules".
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Total order used for FIFO allocation tie-breaks (same in SQL and TS). */
    seq: bigserial("seq", { mode: "bigint" }).notNull().unique(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => driverAccounts.id),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    entryType: ledgerEntryType("entry_type").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    /** Manila date the entry belongs to. */
    businessDate: date("business_date").notNull(),
    /** For debits: when it is due (drives FIFO order and aging). */
    dueDate: date("due_date"),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    planId: uuid("plan_id").references(() => boundaryPlans.id),
    paymentId: uuid("payment_id").references(() => payments.id),
    reversesEntryId: uuid("reverses_entry_id").unique(),
    idempotencyKey: text("idempotency_key").unique(),
    memo: text("memo").notNull().default(""),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => profiles.id),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_account_idx").on(t.accountId, t.dueDate),
    index("ledger_driver_date_idx").on(t.driverId, t.businessDate),
    index("ledger_payment_idx").on(t.paymentId),
    check("ledger_amount_nonzero", sql`${t.amountCentavos} <> 0`),
    check(
      "ledger_sign_by_type",
      sql`CASE ${t.entryType}
        WHEN 'boundary_charge' THEN ${t.amountCentavos} > 0
        WHEN 'amortization_charge' THEN ${t.amountCentavos} > 0
        WHEN 'cost_charge' THEN ${t.amountCentavos} > 0
        WHEN 'deposit_charge' THEN ${t.amountCentavos} > 0
        WHEN 'payment' THEN ${t.amountCentavos} < 0
        WHEN 'bonus_credit' THEN ${t.amountCentavos} < 0
        ELSE true END`,
    ),
    check(
      "ledger_debits_have_due_date",
      sql`${t.entryType} = 'reversal' OR ${t.amountCentavos} < 0 OR ${t.dueDate} IS NOT NULL`,
    ),
    check(
      "ledger_reversal_link",
      sql`(${t.entryType} = 'reversal') = (${t.reversesEntryId} IS NOT NULL)`,
    ),
    check(
      "ledger_reason_required",
      sql`${t.entryType} NOT IN ('reversal', 'adjustment', 'opening_balance') OR coalesce(${t.reason}, '') <> ''`,
    ),
    check("ledger_payment_link", sql`(${t.entryType} = 'payment') = (${t.paymentId} IS NOT NULL)`),
  ],
);

/** The collector's split of a payment across the driver's accounts. */
export const paymentLines = pgTable(
  "payment_lines",
  {
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => driverAccounts.id),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    ledgerEntryId: uuid("ledger_entry_id")
      .notNull()
      .references(() => ledgerEntries.id)
      .unique(),
  },
  (t) => [
    primaryKey({ columns: [t.paymentId, t.accountId] }),
    check("payment_lines_amount_pos", sql`${t.amountCentavos} > 0`),
  ],
);

export const paymentVoids = pgTable("payment_voids", {
  paymentId: uuid("payment_id")
    .primaryKey()
    .references(() => payments.id),
  reason: text("reason").notNull(),
  voidedBy: uuid("voided_by")
    .notNull()
    .references(() => profiles.id),
  voidedAt: timestamp("voided_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cash handed over by a collector to the office. */
export const remittances = pgTable(
  "remittances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectorId: uuid("collector_id")
      .notNull()
      .references(() => profiles.id),
    businessDate: date("business_date").notNull(),
    /** Snapshot of the linked cash payments at the time of remittance. */
    expectedCentavos: bigint("expected_centavos", { mode: "bigint" }).notNull(),
    remittedCentavos: bigint("remitted_centavos", { mode: "bigint" }).notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => profiles.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes").notNull().default(""),
  },
  (t) => [
    index("remittances_collector_idx").on(t.collectorId, t.businessDate),
    check("remittances_amounts_nonneg", sql`${t.expectedCentavos} >= 0 AND ${t.remittedCentavos} >= 0`),
  ],
);

export const remittancePayments = pgTable("remittance_payments", {
  remittanceId: uuid("remittance_id")
    .notNull()
    .references(() => remittances.id),
  paymentId: uuid("payment_id")
    .primaryKey()
    .references(() => payments.id),
});

/** One row per execution of the daily boundary charge job. */
export const chargeRuns = pgTable(
  "charge_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    status: chargeRunStatus("status").notNull().default("running"),
    chargesPosted: integer("charges_posted").notNull().default(0),
    triggeredBy: text("triggered_by").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("charge_runs_to_idx").on(t.toDate)],
);

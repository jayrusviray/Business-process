import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgSequence, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { loanStatus, rtoStatus } from "./enums";
import { drivers, vehicles } from "./fleet";
import { profiles } from "./foundation";
import { driverAccounts } from "./ledger";

export const rtoContractSeq = pgSequence("rto_contract_seq", { startWith: 1 });

/**
 * Rent-to-own / boundary-hulog contract (owner: same program, 5-year term).
 * No interest (owner, 2026-09-27): installment = (price − down payment) ÷ term,
 * with the last installment absorbing any centavo remainder. The installments
 * are computed (src/lib/rto.ts) and posted as amortization_charge entries on
 * their due dates by the daily job; they are never stored as a schedule table.
 */
export const rtoContracts = pgTable(
  "rto_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractNo: text("contract_no")
      .notNull()
      .unique()
      .default(sql`('RTO-' || lpad(nextval('rto_contract_seq')::text, 5, '0'))`),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => driverAccounts.id)
      .unique(),
    contractPriceCentavos: bigint("contract_price_centavos", { mode: "bigint" }).notNull(),
    downPaymentCentavos: bigint("down_payment_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    termMonths: integer("term_months").notNull().default(60),
    /** Contract signing date; the down payment (if any) is due on this date. */
    startDate: date("start_date").notNull(),
    /** Due date of installment #1; later installments fall on the same day of month (clamped). */
    firstDueDate: date("first_due_date").notNull(),
    status: rtoStatus("status").notNull().default("active"),
    closedOn: date("closed_on"),
    closeReason: text("close_reason"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    index("rto_contracts_driver_idx").on(t.driverId),
    index("rto_contracts_vehicle_idx").on(t.vehicleId),
    check("rto_price_pos", sql`${t.contractPriceCentavos} > 0`),
    check("rto_down_range", sql`${t.downPaymentCentavos} >= 0 AND ${t.downPaymentCentavos} < ${t.contractPriceCentavos}`),
    check("rto_term_range", sql`${t.termMonths} BETWEEN 1 AND 120`),
    check("rto_first_due_after_start", sql`${t.firstDueDate} >= ${t.startDate}`),
    check("rto_closed_consistent", sql`(${t.status} = 'active') = (${t.closedOn} IS NULL)`),
  ],
);

/**
 * Bank/dealer financing of a vehicle (owner: diminishing balance). The
 * schedule is generated once at creation; a restructure = a new loan.
 */
export const vehicleLoans = pgTable(
  "vehicle_loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    lender: text("lender").notNull(),
    principalCentavos: bigint("principal_centavos", { mode: "bigint" }).notNull(),
    /** Annual interest rate in basis points (12% = 1200). */
    annualRateBps: integer("annual_rate_bps").notNull(),
    termMonths: integer("term_months").notNull(),
    firstDueDate: date("first_due_date").notNull(),
    status: loanStatus("status").notNull().default("active"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    index("vehicle_loans_vehicle_idx").on(t.vehicleId),
    check("loan_principal_pos", sql`${t.principalCentavos} > 0`),
    check("loan_rate_range", sql`${t.annualRateBps} BETWEEN 0 AND 10000`),
    check("loan_term_range", sql`${t.termMonths} BETWEEN 1 AND 120`),
  ],
);

export const loanScheduleLines = pgTable(
  "loan_schedule_lines",
  {
    loanId: uuid("loan_id")
      .notNull()
      .references(() => vehicleLoans.id),
    seq: integer("seq").notNull(),
    dueDate: date("due_date").notNull(),
    openingBalanceCentavos: bigint("opening_balance_centavos", { mode: "bigint" }).notNull(),
    principalCentavos: bigint("principal_centavos", { mode: "bigint" }).notNull(),
    interestCentavos: bigint("interest_centavos", { mode: "bigint" }).notNull(),
    paymentCentavos: bigint("payment_centavos", { mode: "bigint" }).notNull(),
    closingBalanceCentavos: bigint("closing_balance_centavos", { mode: "bigint" }).notNull(),
  },
  (t) => [
    unique("loan_schedule_uq").on(t.loanId, t.seq),
    check("loan_line_math", sql`${t.paymentCentavos} = ${t.principalCentavos} + ${t.interestCentavos}
      AND ${t.closingBalanceCentavos} = ${t.openingBalanceCentavos} - ${t.principalCentavos}`),
  ],
);

/** Payments TransRev makes to the lender. Applied to schedule lines oldest-first (computed). */
export const loanPayments = pgTable(
  "loan_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => vehicleLoans.id),
    paidOn: date("paid_on").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** Set on a correcting entry: negative amount reversing a mistaken payment. */
    reversesPaymentId: uuid("reverses_payment_id").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [
    index("loan_payments_loan_idx").on(t.loanId),
    check("loan_payment_sign", sql`(${t.reversesPaymentId} IS NULL AND ${t.amountCentavos} > 0) OR (${t.reversesPaymentId} IS NOT NULL AND ${t.amountCentavos} < 0)`),
  ],
);

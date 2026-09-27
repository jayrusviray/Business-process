import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  caSettlementKind,
  commissionStatus,
  employeeStatus,
  investorPayoutStatus,
  payrollStatus,
  salaryBasis,
} from "./enums";
import { drivers, vehicles } from "./fleet";
import { documents, profiles } from "./foundation";
import { rtoContracts } from "./rto";

const created = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => profiles.id),
});
const updated = () => ({
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => profiles.id),
});
const voidCols = () => ({
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: uuid("voided_by").references(() => profiles.id),
  voidReason: text("void_reason"),
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export const expenseCategories = pgTable("expense_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(100),
});

/** Bills that repeat monthly (rent, internet, phone plans…). Each month's payment is a normal expense. */
export const recurringExpenses = pgTable(
  "recurring_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id").notNull().references(() => expenseCategories.id),
    vendor: text("vendor").notNull(),
    description: text("description").notNull().default(""),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    dueDay: integer("due_day").notNull(),
    startMonth: date("start_month").notNull(),
    endMonth: date("end_month"),
    active: boolean("active").notNull().default(true),
    ...created(),
    ...updated(),
  },
  (t) => [check("recurring_amount_pos", sql`${t.amountCentavos} > 0`), check("recurring_due_day", sql`${t.dueDay} BETWEEN 1 AND 31`)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id").notNull().references(() => expenseCategories.id),
    vendor: text("vendor").notNull().default(""),
    description: text("description").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    expenseDate: date("expense_date").notNull(),
    paidVia: text("paid_via").notNull().default("cash"),
    reference: text("reference").notNull().default(""),
    /** Optional: counts against this vehicle in per-vehicle profitability. */
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    /** Set for expenses coming from a cash-advance liquidation or reimbursement. */
    employeeId: uuid("employee_id"),
    receiptDocumentId: uuid("receipt_document_id").references(() => documents.id),
    recurringId: uuid("recurring_id").references(() => recurringExpenses.id),
    recurringMonth: date("recurring_month"),
    ...created(),
    ...voidCols(),
  },
  (t) => [
    index("expenses_date_idx").on(t.expenseDate),
    index("expenses_vehicle_idx").on(t.vehicleId),
    unique("expenses_recurring_month_uq").on(t.recurringId, t.recurringMonth),
    check("expenses_amount_pos", sql`${t.amountCentavos} > 0`),
    check("expenses_recurring_pair", sql`(${t.recurringId} IS NULL) = (${t.recurringMonth} IS NULL)`),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    categoryId: uuid("category_id").notNull().references(() => expenseCategories.id),
    month: date("month").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    ...updated(),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.month] }), check("budgets_amount_nonneg", sql`${t.amountCentavos} >= 0`)],
);

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeNo: text("employee_no").notNull().unique(),
    profileId: uuid("profile_id").references(() => profiles.id).unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    position: text("position").notNull().default(""),
    hireDate: date("hire_date").notNull(),
    separationDate: date("separation_date"),
    basis: salaryBasis("basis").notNull(),
    /** Monthly salary (monthly basis) or daily rate (daily basis). */
    rateCentavos: bigint("rate_centavos", { mode: "bigint" }).notNull(),
    allowanceCentavos: bigint("allowance_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    allowanceTaxable: boolean("allowance_taxable").notNull().default(false),
    tin: text("tin").notNull().default(""),
    sssNo: text("sss_no").notNull().default(""),
    philhealthNo: text("philhealth_no").notNull().default(""),
    pagibigNo: text("pagibig_no").notNull().default(""),
    bankAccount: text("bank_account").notNull().default(""),
    status: employeeStatus("status").notNull().default("active"),
    ...created(),
    ...updated(),
  },
  (t) => [check("employees_rate_pos", sql`${t.rateCentavos} > 0`), check("employees_allowance_nonneg", sql`${t.allowanceCentavos} >= 0`)],
);

export const payrollPeriods = pgTable(
  "payroll_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodStart: date("period_start").notNull().unique(),
    periodEnd: date("period_end").notNull(),
    half: integer("half").notNull(),
    payDate: date("pay_date").notNull(),
    status: payrollStatus("status").notNull().default("draft"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: uuid("finalized_by").references(() => profiles.id),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: uuid("paid_by").references(() => profiles.id),
    ...created(),
    ...updated(),
  },
  (t) => [check("payroll_half", sql`${t.half} IN (1, 2)`), check("payroll_dates", sql`${t.periodEnd} >= ${t.periodStart}`)],
);

/**
 * One employee in one period. Inputs are editable while the period is a draft;
 * the computed breakdown is stored as a snapshot (incl. the rate and government
 * table versions used). Finalized periods are locked; corrections go into the
 * next period as other earnings/deductions.
 */
export const payrollLines = pgTable(
  "payroll_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id").notNull().references(() => payrollPeriods.id),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    basis: salaryBasis("basis").notNull(),
    rateCentavos: bigint("rate_centavos", { mode: "bigint" }).notNull(),
    allowanceCentavos: bigint("allowance_centavos", { mode: "bigint" }).notNull(),
    allowanceTaxable: boolean("allowance_taxable").notNull(),
    daysWorkedHundredths: integer("days_worked_hundredths").notNull().default(0),
    daysAbsentHundredths: integer("days_absent_hundredths").notNull().default(0),
    minutesLate: integer("minutes_late").notNull().default(0),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    restSpecialMinutes: integer("rest_special_minutes").notNull().default(0),
    regularHolidayMinutes: integer("regular_holiday_minutes").notNull().default(0),
    unworkedRegularHolidays: integer("unworked_regular_holidays").notNull().default(0),
    nightDiffMinutes: integer("night_diff_minutes").notNull().default(0),
    otherTaxableEarningsCentavos: bigint("other_taxable_earnings_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    reimbursementsCentavos: bigint("reimbursements_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    otherDeductionsCentavos: bigint("other_deductions_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    cashAdvanceDeductionCentavos: bigint("cash_advance_deduction_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    notes: text("notes").notNull().default(""),
    grossTaxableCentavos: bigint("gross_taxable_centavos", { mode: "bigint" }).notNull(),
    withholdingTaxCentavos: bigint("withholding_tax_centavos", { mode: "bigint" }).notNull(),
    basicEarnedCentavos: bigint("basic_earned_centavos", { mode: "bigint" }).notNull(),
    netPayCentavos: bigint("net_pay_centavos", { mode: "bigint" }).notNull(),
    /** Full breakdown (strings of centavos) + government table ids used. */
    computed: jsonb("computed").notNull(),
    ...created(),
    ...updated(),
  },
  (t) => [
    unique("payroll_lines_period_employee_uq").on(t.periodId, t.employeeId),
    check(
      "payroll_lines_inputs_nonneg",
      sql`${t.daysWorkedHundredths} >= 0 AND ${t.daysAbsentHundredths} >= 0 AND ${t.minutesLate} >= 0 AND ${t.overtimeMinutes} >= 0
        AND ${t.restSpecialMinutes} >= 0 AND ${t.regularHolidayMinutes} >= 0 AND ${t.unworkedRegularHolidays} >= 0 AND ${t.nightDiffMinutes} >= 0
        AND ${t.otherTaxableEarningsCentavos} >= 0 AND ${t.reimbursementsCentavos} >= 0 AND ${t.otherDeductionsCentavos} >= 0
        AND ${t.cashAdvanceDeductionCentavos} >= 0`,
    ),
  ],
);

/** Cash given to staff for business meetings/travel (owner). Settled by liquidation, salary deduction or cash return. */
export const cashAdvances = pgTable(
  "cash_advances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    givenOn: date("given_on").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    purpose: text("purpose").notNull(),
    ...created(),
    ...voidCols(),
  },
  (t) => [index("cash_advances_employee_idx").on(t.employeeId), check("cash_advances_amount_pos", sql`${t.amountCentavos} > 0`)],
);

export const cashAdvanceSettlements = pgTable(
  "cash_advance_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cashAdvanceId: uuid("cash_advance_id").notNull().references(() => cashAdvances.id),
    kind: caSettlementKind("kind").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    settledOn: date("settled_on").notNull(),
    expenseId: uuid("expense_id").references(() => expenses.id),
    payrollLineId: uuid("payroll_line_id").references(() => payrollLines.id),
    notes: text("notes").notNull().default(""),
    ...created(),
  },
  (t) => [
    index("ca_settlements_ca_idx").on(t.cashAdvanceId),
    unique("ca_settlements_payroll_uq").on(t.cashAdvanceId, t.payrollLineId),
    check("ca_settlements_amount_pos", sql`${t.amountCentavos} > 0`),
    check("ca_settlements_links", sql`(${t.kind} = 'liquidation') = (${t.expenseId} IS NOT NULL) AND (${t.kind} = 'payroll_deduction') = (${t.payrollLineId} IS NOT NULL)`),
  ],
);

export const thirteenthMonthPayouts = pgTable(
  "thirteenth_month_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").notNull().references(() => employees.id),
    year: integer("year").notNull(),
    basicEarnedCentavos: bigint("basic_earned_centavos", { mode: "bigint" }).notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    paidOn: date("paid_on").notNull(),
    reference: text("reference").notNull().default(""),
    ...created(),
  },
  (t) => [unique("thirteenth_employee_year_uq").on(t.employeeId, t.year), check("thirteenth_amount_nonneg", sql`${t.amountCentavos} >= 0`)],
);

// ---------------------------------------------------------------------------
// Commissions
// ---------------------------------------------------------------------------
/** Owner: 10% of the referred driver's down payment, payable after one month. */
export const referralCommissions = pgTable(
  "referral_commissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rtoContractId: uuid("rto_contract_id").notNull().references(() => rtoContracts.id).unique(),
    referrerType: text("referrer_type").notNull(),
    referrerName: text("referrer_name").notNull(),
    referrerPhone: text("referrer_phone").notNull().default(""),
    referrerDriverId: uuid("referrer_driver_id").references(() => drivers.id),
    baseCentavos: bigint("base_centavos", { mode: "bigint" }).notNull(),
    rateBps: integer("rate_bps").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    payableOn: date("payable_on").notNull(),
    status: commissionStatus("status").notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => profiles.id),
    paidOn: date("paid_on"),
    paidReference: text("paid_reference"),
    voidReason: text("void_reason"),
    ...created(),
    ...updated(),
  },
  (t) => [
    check("referral_type", sql`${t.referrerType} IN ('driver', 'employee', 'external')`),
    check("referral_amount_nonneg", sql`${t.amountCentavos} >= 0 AND ${t.baseCentavos} >= 0`),
  ],
);

/** Money TransRev receives from platforms or dealers. */
export const commissionsReceived = pgTable(
  "commissions_received",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: text("source_type").notNull(),
    counterparty: text("counterparty").notNull(),
    description: text("description").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    receivedOn: date("received_on").notNull(),
    reference: text("reference").notNull().default(""),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    driverId: uuid("driver_id").references(() => drivers.id),
    ...created(),
    ...voidCols(),
  },
  (t) => [
    check("commissions_received_source", sql`${t.sourceType} IN ('platform', 'dealer', 'other')`),
    check("commissions_received_amount_pos", sql`${t.amountCentavos} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Investors
// ---------------------------------------------------------------------------
export const investors = pgTable("investors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone").notNull().default(""),
  email: text("email"),
  profileId: uuid("profile_id").references(() => profiles.id).unique(),
  notes: text("notes").notNull().default(""),
  ...created(),
  ...updated(),
});

/**
 * Monthly investor share per vehicle (owner): 22 × the driver's daily boundary
 * rate − the driver's monthly RTO amortization. Drafts can be regenerated; paid rows are locked.
 */
export const investorPayouts = pgTable(
  "investor_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    month: date("month").notNull(),
    vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id),
    investorId: uuid("investor_id").notNull().references(() => investors.id),
    driverId: uuid("driver_id").references(() => drivers.id),
    dailyRateCentavos: bigint("daily_rate_centavos", { mode: "bigint" }).notNull(),
    monthlyAmortizationCentavos: bigint("monthly_amortization_centavos", { mode: "bigint" }).notNull(),
    boundaryDays: integer("boundary_days").notNull(),
    computedCentavos: bigint("computed_centavos", { mode: "bigint" }).notNull(),
    payableCentavos: bigint("payable_centavos", { mode: "bigint" }).notNull(),
    status: investorPayoutStatus("status").notNull().default("draft"),
    paidOn: date("paid_on"),
    reference: text("reference"),
    ...created(),
    ...updated(),
  },
  (t) => [
    unique("investor_payouts_month_vehicle_uq").on(t.month, t.vehicleId),
    index("investor_payouts_investor_idx").on(t.investorId, t.month),
    check("investor_payouts_payable_nonneg", sql`${t.payableCentavos} >= 0`),
  ],
);

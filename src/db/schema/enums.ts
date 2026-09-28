import { pgEnum } from "drizzle-orm/pg-core";

/** Application roles. Keep in sync with `src/lib/auth/roles.ts`. */
export const appRole = pgEnum("app_role", [
  "owner_admin",
  "finance",
  "operations",
  "sales",
  "driver",
  "investor",
  "documentation",
]);

export const profileStatus = pgEnum("profile_status", ["active", "disabled"]);

export const govAgency = pgEnum("gov_agency", [
  "sss",
  "philhealth",
  "pagibig",
  "bir_wtax",
]);

export const driverStatus = pgEnum("driver_status", ["applicant", "active", "suspended", "completed", "terminated"]);

/** Owner confirmed boundary-hulog and RTO are the same program (2026-09-27). */
export const programType = pgEnum("program_type", ["boundary", "rto"]);

export const vehicleStatus = pgEnum("vehicle_status", ["available", "assigned", "maintenance", "transferred", "retired"]);

export const fundingSource = pgEnum("funding_source", ["company", "investor", "financed"]);

export const franchiseKind = pgEnum("franchise_kind", ["PA", "CPC"]);

/**
 * A driver's obligations are split into separate accounts; payments never
 * spill across accounts automatically (the collector decides the split).
 *   boundary      daily boundary charges
 *   amortization  monthly RTO/hulog amortization (Phase 4)
 *   charges       driver-borne costs (at cost) and the non-refundable deposit
 */
export const accountKind = pgEnum("account_kind", ["boundary", "amortization", "charges"]);

export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "opening_balance",
  "boundary_charge",
  "amortization_charge",
  "cost_charge",
  "deposit_charge",
  "payment",
  "bonus_credit",
  "adjustment",
  "reversal",
]);

export const paymentMethod = pgEnum("payment_method", ["cash", "gcash", "maya", "bank_transfer", "other"]);

export const chargeRunStatus = pgEnum("charge_run_status", ["running", "succeeded", "failed"]);

export const quotaMetric = pgEnum("quota_metric", ["trips", "earnings_centavos", "boundary_days_paid"]);
export const quotaPeriod = pgEnum("quota_period", ["monthly", "weekly"]);
export const bonusPayoutMode = pgEnum("bonus_payout_mode", ["credit", "cash"]);
export const quotaResultSource = pgEnum("quota_result_source", ["manual", "csv"]);

export const rtoStatus = pgEnum("rto_status", ["active", "completed", "cashed_out", "terminated"]);
export const loanStatus = pgEnum("loan_status", ["active", "paid_off", "restructured"]);

export const messageLanguage = pgEnum("message_language", ["en", "taglish"]);
export const reminderTrigger = pgEnum("reminder_trigger", [
  "balance_weekly",
  "missed_boundary",
  "amortization_upcoming",
  "amortization_missed",
  "rto_milestone",
  "license_expiry",
  "manual",
]);
export const messageStatus = pgEnum("message_status", ["pending", "sent", "skipped", "failed"]);

export const salaryBasis = pgEnum("salary_basis", ["monthly", "daily"]);
export const employeeStatus = pgEnum("employee_status", ["active", "inactive"]);
export const payrollStatus = pgEnum("payroll_status", ["draft", "finalized", "paid"]);
export const caSettlementKind = pgEnum("ca_settlement_kind", ["liquidation", "payroll_deduction", "cash_return"]);
export const commissionStatus = pgEnum("commission_status", ["pending", "approved", "paid", "void"]);
export const investorPayoutStatus = pgEnum("investor_payout_status", ["draft", "paid"]);

export const proofStatus = pgEnum("proof_status", ["pending", "approved", "rejected"]);

/** Where a lead came from (spec 4.10). */
export const leadSource = pgEnum("lead_source", [
  "facebook_page",
  "messenger",
  "fb_lead_ad",
  "landing_page",
  "referral",
  "walk_in",
  "tiktok",
  "other",
]);
/** TransRev service lines (landing page, CRM interest, application types). */
export const serviceLine = pgEnum("service_line", ["franchise", "activation", "vehicle_program", "fleet", "investment", "school", "other"]);
export const leadStageKind = pgEnum("lead_stage_kind", ["open", "won", "lost"]);
export const contactMethod = pgEnum("contact_method", ["call", "sms", "messenger", "viber", "email"]);
export const leadActivityKind = pgEnum("lead_activity_kind", [
  "note",
  "call",
  "message",
  "inquiry",
  "stage_change",
  "assignment",
  "follow_up_done",
  "converted",
  "import",
]);
/** Sections of the public website that staff edit without a deploy. */
export const siteSection = pgEnum("site_section", ["hero", "service", "audience", "step", "requirement", "program", "faq", "school", "privacy"]);

/** Vehicle type (spec 4.2). `vehicles.is_ev` is derived from it. */
export const powertrain = pgEnum("powertrain", ["ice", "ev", "hybrid"]);
export const clientKind = pgEnum("client_kind", ["person", "company"]);
/**
 * What an application status means for reports: in progress, approved/activated,
 * released/completed, on hold, or cancelled.
 */
export const applicationStatusKind = pgEnum("application_status_kind", ["open", "approved", "completed", "on_hold", "cancelled"]);
export const commissionMode = pgEnum("commission_mode", ["fixed", "percent"]);

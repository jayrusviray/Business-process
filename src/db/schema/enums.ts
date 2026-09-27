import { pgEnum } from "drizzle-orm/pg-core";

/** Application roles. Keep in sync with `src/lib/auth/roles.ts`. */
export const appRole = pgEnum("app_role", [
  "owner_admin",
  "finance",
  "operations",
  "sales",
  "driver",
  "investor",
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

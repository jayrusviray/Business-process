CREATE TYPE "public"."ca_settlement_kind" AS ENUM('liquidation', 'payroll_deduction', 'cash_return');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('pending', 'approved', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."investor_payout_status" AS ENUM('draft', 'paid');--> statement-breakpoint
CREATE TYPE "public"."payroll_status" AS ENUM('draft', 'finalized', 'paid');--> statement-breakpoint
CREATE TYPE "public"."salary_basis" AS ENUM('monthly', 'daily');--> statement-breakpoint
CREATE TABLE "budgets" (
	"category_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "budgets_category_id_month_pk" PRIMARY KEY("category_id","month"),
	CONSTRAINT "budgets_amount_nonneg" CHECK ("budgets"."amount_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cash_advance_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cash_advance_id" uuid NOT NULL,
	"kind" "ca_settlement_kind" NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"settled_on" date NOT NULL,
	"expense_id" uuid,
	"payroll_line_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "ca_settlements_payroll_uq" UNIQUE("cash_advance_id","payroll_line_id"),
	CONSTRAINT "ca_settlements_amount_pos" CHECK ("cash_advance_settlements"."amount_centavos" > 0),
	CONSTRAINT "ca_settlements_links" CHECK (("cash_advance_settlements"."kind" = 'liquidation') = ("cash_advance_settlements"."expense_id" IS NOT NULL) AND ("cash_advance_settlements"."kind" = 'payroll_deduction') = ("cash_advance_settlements"."payroll_line_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cash_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"given_on" date NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "cash_advances_amount_pos" CHECK ("cash_advances"."amount_centavos" > 0)
);
--> statement-breakpoint
CREATE TABLE "commissions_received" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"counterparty" text NOT NULL,
	"description" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"received_on" date NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"vehicle_id" uuid,
	"driver_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "commissions_received_source" CHECK ("commissions_received"."source_type" IN ('platform', 'dealer', 'other')),
	CONSTRAINT "commissions_received_amount_pos" CHECK ("commissions_received"."amount_centavos" > 0)
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_no" text NOT NULL,
	"profile_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"position" text DEFAULT '' NOT NULL,
	"hire_date" date NOT NULL,
	"separation_date" date,
	"basis" "salary_basis" NOT NULL,
	"rate_centavos" bigint NOT NULL,
	"allowance_centavos" bigint DEFAULT 0 NOT NULL,
	"allowance_taxable" boolean DEFAULT false NOT NULL,
	"tin" text DEFAULT '' NOT NULL,
	"sss_no" text DEFAULT '' NOT NULL,
	"philhealth_no" text DEFAULT '' NOT NULL,
	"pagibig_no" text DEFAULT '' NOT NULL,
	"bank_account" text DEFAULT '' NOT NULL,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "employees_employee_no_unique" UNIQUE("employee_no"),
	CONSTRAINT "employees_profile_id_unique" UNIQUE("profile_id"),
	CONSTRAINT "employees_rate_pos" CHECK ("employees"."rate_centavos" > 0),
	CONSTRAINT "employees_allowance_nonneg" CHECK ("employees"."allowance_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "expense_categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"expense_date" date NOT NULL,
	"paid_via" text DEFAULT 'cash' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"vehicle_id" uuid,
	"employee_id" uuid,
	"receipt_document_id" uuid,
	"recurring_id" uuid,
	"recurring_month" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "expenses_recurring_month_uq" UNIQUE("recurring_id","recurring_month"),
	CONSTRAINT "expenses_amount_pos" CHECK ("expenses"."amount_centavos" > 0),
	CONSTRAINT "expenses_recurring_pair" CHECK (("expenses"."recurring_id" IS NULL) = ("expenses"."recurring_month" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "investor_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"driver_id" uuid,
	"daily_rate_centavos" bigint NOT NULL,
	"monthly_amortization_centavos" bigint NOT NULL,
	"boundary_days" integer NOT NULL,
	"computed_centavos" bigint NOT NULL,
	"payable_centavos" bigint NOT NULL,
	"status" "investor_payout_status" DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "investor_payouts_month_vehicle_uq" UNIQUE("month","vehicle_id"),
	CONSTRAINT "investor_payouts_payable_nonneg" CHECK ("investor_payouts"."payable_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "investors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text,
	"profile_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "investors_profile_id_unique" UNIQUE("profile_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"basis" "salary_basis" NOT NULL,
	"rate_centavos" bigint NOT NULL,
	"allowance_centavos" bigint NOT NULL,
	"allowance_taxable" boolean NOT NULL,
	"days_worked_hundredths" integer DEFAULT 0 NOT NULL,
	"days_absent_hundredths" integer DEFAULT 0 NOT NULL,
	"minutes_late" integer DEFAULT 0 NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"rest_special_minutes" integer DEFAULT 0 NOT NULL,
	"regular_holiday_minutes" integer DEFAULT 0 NOT NULL,
	"unworked_regular_holidays" integer DEFAULT 0 NOT NULL,
	"night_diff_minutes" integer DEFAULT 0 NOT NULL,
	"other_taxable_earnings_centavos" bigint DEFAULT 0 NOT NULL,
	"reimbursements_centavos" bigint DEFAULT 0 NOT NULL,
	"other_deductions_centavos" bigint DEFAULT 0 NOT NULL,
	"cash_advance_deduction_centavos" bigint DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"gross_taxable_centavos" bigint NOT NULL,
	"withholding_tax_centavos" bigint NOT NULL,
	"basic_earned_centavos" bigint NOT NULL,
	"net_pay_centavos" bigint NOT NULL,
	"computed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "payroll_lines_period_employee_uq" UNIQUE("period_id","employee_id"),
	CONSTRAINT "payroll_lines_inputs_nonneg" CHECK ("payroll_lines"."days_worked_hundredths" >= 0 AND "payroll_lines"."days_absent_hundredths" >= 0 AND "payroll_lines"."minutes_late" >= 0 AND "payroll_lines"."overtime_minutes" >= 0
        AND "payroll_lines"."rest_special_minutes" >= 0 AND "payroll_lines"."regular_holiday_minutes" >= 0 AND "payroll_lines"."unworked_regular_holidays" >= 0 AND "payroll_lines"."night_diff_minutes" >= 0
        AND "payroll_lines"."other_taxable_earnings_centavos" >= 0 AND "payroll_lines"."reimbursements_centavos" >= 0 AND "payroll_lines"."other_deductions_centavos" >= 0
        AND "payroll_lines"."cash_advance_deduction_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"half" integer NOT NULL,
	"pay_date" date NOT NULL,
	"status" "payroll_status" DEFAULT 'draft' NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "payroll_periods_period_start_unique" UNIQUE("period_start"),
	CONSTRAINT "payroll_half" CHECK ("payroll_periods"."half" IN (1, 2)),
	CONSTRAINT "payroll_dates" CHECK ("payroll_periods"."period_end" >= "payroll_periods"."period_start")
);
--> statement-breakpoint
CREATE TABLE "recurring_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"due_day" integer NOT NULL,
	"start_month" date NOT NULL,
	"end_month" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "recurring_amount_pos" CHECK ("recurring_expenses"."amount_centavos" > 0),
	CONSTRAINT "recurring_due_day" CHECK ("recurring_expenses"."due_day" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "referral_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rto_contract_id" uuid NOT NULL,
	"referrer_type" text NOT NULL,
	"referrer_name" text NOT NULL,
	"referrer_phone" text DEFAULT '' NOT NULL,
	"referrer_driver_id" uuid,
	"base_centavos" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"payable_on" date NOT NULL,
	"status" "commission_status" DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"paid_on" date,
	"paid_reference" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "referral_commissions_rto_contract_id_unique" UNIQUE("rto_contract_id"),
	CONSTRAINT "referral_type" CHECK ("referral_commissions"."referrer_type" IN ('driver', 'employee', 'external')),
	CONSTRAINT "referral_amount_nonneg" CHECK ("referral_commissions"."amount_centavos" >= 0 AND "referral_commissions"."base_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "thirteenth_month_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"basic_earned_centavos" bigint NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "thirteenth_employee_year_uq" UNIQUE("employee_id","year"),
	CONSTRAINT "thirteenth_amount_nonneg" CHECK ("thirteenth_month_payouts"."amount_centavos" >= 0)
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlements" ADD CONSTRAINT "cash_advance_settlements_cash_advance_id_cash_advances_id_fk" FOREIGN KEY ("cash_advance_id") REFERENCES "public"."cash_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlements" ADD CONSTRAINT "cash_advance_settlements_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlements" ADD CONSTRAINT "cash_advance_settlements_payroll_line_id_payroll_lines_id_fk" FOREIGN KEY ("payroll_line_id") REFERENCES "public"."payroll_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlements" ADD CONSTRAINT "cash_advance_settlements_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advances" ADD CONSTRAINT "cash_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advances" ADD CONSTRAINT "cash_advances_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advances" ADD CONSTRAINT "cash_advances_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions_received" ADD CONSTRAINT "commissions_received_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions_received" ADD CONSTRAINT "commissions_received_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions_received" ADD CONSTRAINT "commissions_received_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions_received" ADD CONSTRAINT "commissions_received_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_document_id_documents_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurring_id_recurring_expenses_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_payouts" ADD CONSTRAINT "investor_payouts_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_payouts" ADD CONSTRAINT "investor_payouts_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_payouts" ADD CONSTRAINT "investor_payouts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_payouts" ADD CONSTRAINT "investor_payouts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_payouts" ADD CONSTRAINT "investor_payouts_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_period_id_payroll_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_finalized_by_profiles_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_paid_by_profiles_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_rto_contract_id_rto_contracts_id_fk" FOREIGN KEY ("rto_contract_id") REFERENCES "public"."rto_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referrer_driver_id_drivers_id_fk" FOREIGN KEY ("referrer_driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ca_settlements_ca_idx" ON "cash_advance_settlements" USING btree ("cash_advance_id");--> statement-breakpoint
CREATE INDEX "cash_advances_employee_idx" ON "cash_advances" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("expense_date");--> statement-breakpoint
CREATE INDEX "expenses_vehicle_idx" ON "expenses" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "investor_payouts_investor_idx" ON "investor_payouts" USING btree ("investor_id","month");
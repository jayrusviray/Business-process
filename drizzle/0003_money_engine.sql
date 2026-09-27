CREATE TYPE "public"."account_kind" AS ENUM('boundary', 'amortization', 'charges');--> statement-breakpoint
CREATE TYPE "public"."charge_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."driver_status" AS ENUM('applicant', 'active', 'suspended', 'completed', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."franchise_kind" AS ENUM('PA', 'CPC');--> statement-breakpoint
CREATE TYPE "public"."funding_source" AS ENUM('company', 'investor', 'financed');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('opening_balance', 'boundary_charge', 'amortization_charge', 'cost_charge', 'deposit_charge', 'payment', 'bonus_credit', 'adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'gcash', 'maya', 'bank_transfer', 'other');--> statement-breakpoint
CREATE TYPE "public"."program_type" AS ENUM('boundary', 'rto');--> statement-breakpoint
CREATE TYPE "public"."vehicle_status" AS ENUM('available', 'assigned', 'maintenance', 'transferred', 'retired');--> statement-breakpoint
CREATE SEQUENCE "public"."payment_receipt_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"address" text DEFAULT '' NOT NULL,
	"birthdate" date,
	"license_no" text,
	"license_expiry" date,
	"emergency_contact_name" text DEFAULT '' NOT NULL,
	"emergency_contact_phone" text DEFAULT '' NOT NULL,
	"status" "driver_status" DEFAULT 'applicant' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "drivers_profile_id_unique" UNIQUE("profile_id")
);
--> statement-breakpoint
CREATE TABLE "franchises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid,
	"operator_name" text NOT NULL,
	"kind" "franchise_kind" NOT NULL,
	"number" text NOT NULL,
	"issued_on" date,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"date" date PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "vehicle_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "assignments_dates" CHECK ("vehicle_assignments"."end_date" IS NULL OR "vehicle_assignments"."end_date" >= "vehicle_assignments"."start_date")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plate_no" text NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"year" integer,
	"color" text DEFAULT '' NOT NULL,
	"is_ev" boolean DEFAULT false NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"platforms" text[] DEFAULT '{}'::text[] NOT NULL,
	"acquisition_cost_centavos" bigint,
	"acquired_on" date,
	"funding_source" "funding_source" DEFAULT 'company' NOT NULL,
	"investor_id" uuid,
	"status" "vehicle_status" DEFAULT 'available' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "vehicles_cost_nonneg" CHECK ("vehicles"."acquisition_cost_centavos" IS NULL OR "vehicles"."acquisition_cost_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "boundary_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"program_type" "program_type" NOT NULL,
	"daily_rate_centavos" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "boundary_plans_rate_pos" CHECK ("boundary_plans"."daily_rate_centavos" > 0),
	CONSTRAINT "boundary_plans_dates" CHECK ("boundary_plans"."effective_to" IS NULL OR "boundary_plans"."effective_to" >= "boundary_plans"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "charge_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"status" charge_run_status DEFAULT 'running' NOT NULL,
	"charges_posted" integer DEFAULT 0 NOT NULL,
	"triggered_by" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "driver_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"kind" "account_kind" NOT NULL,
	"contract_id" uuid,
	"opened_on" date NOT NULL,
	"closed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"account_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"business_date" date NOT NULL,
	"due_date" date,
	"vehicle_id" uuid,
	"plan_id" uuid,
	"payment_id" uuid,
	"reverses_entry_id" uuid,
	"idempotency_key" text,
	"memo" text DEFAULT '' NOT NULL,
	"reason" text,
	"created_by" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_seq_unique" UNIQUE("seq"),
	CONSTRAINT "ledger_entries_reverses_entry_id_unique" UNIQUE("reverses_entry_id"),
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_amount_nonzero" CHECK ("ledger_entries"."amount_centavos" <> 0),
	CONSTRAINT "ledger_sign_by_type" CHECK (CASE "ledger_entries"."entry_type"
        WHEN 'boundary_charge' THEN "ledger_entries"."amount_centavos" > 0
        WHEN 'amortization_charge' THEN "ledger_entries"."amount_centavos" > 0
        WHEN 'cost_charge' THEN "ledger_entries"."amount_centavos" > 0
        WHEN 'deposit_charge' THEN "ledger_entries"."amount_centavos" > 0
        WHEN 'payment' THEN "ledger_entries"."amount_centavos" < 0
        WHEN 'bonus_credit' THEN "ledger_entries"."amount_centavos" < 0
        ELSE true END),
	CONSTRAINT "ledger_debits_have_due_date" CHECK ("ledger_entries"."entry_type" = 'reversal' OR "ledger_entries"."amount_centavos" < 0 OR "ledger_entries"."due_date" IS NOT NULL),
	CONSTRAINT "ledger_reversal_link" CHECK (("ledger_entries"."entry_type" = 'reversal') = ("ledger_entries"."reverses_entry_id" IS NOT NULL)),
	CONSTRAINT "ledger_reason_required" CHECK ("ledger_entries"."entry_type" NOT IN ('reversal', 'adjustment', 'opening_balance') OR coalesce("ledger_entries"."reason", '') <> ''),
	CONSTRAINT "ledger_payment_link" CHECK (("ledger_entries"."entry_type" = 'payment') = ("ledger_entries"."payment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_lines" (
	"payment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	CONSTRAINT "payment_lines_payment_id_account_id_pk" PRIMARY KEY("payment_id","account_id"),
	CONSTRAINT "payment_lines_ledger_entry_id_unique" UNIQUE("ledger_entry_id"),
	CONSTRAINT "payment_lines_amount_pos" CHECK ("payment_lines"."amount_centavos" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_voids" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"voided_by" uuid NOT NULL,
	"voided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text DEFAULT ('AR-' || lpad(nextval('payment_receipt_seq')::text, 6, '0')) NOT NULL,
	"driver_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_no" text,
	"bank_name" text,
	"received_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"collector_id" uuid NOT NULL,
	"receipt_document_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"client_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payments_receipt_no_unique" UNIQUE("receipt_no"),
	CONSTRAINT "payments_client_request_id_unique" UNIQUE("client_request_id"),
	CONSTRAINT "payments_amount_pos" CHECK ("payments"."amount_centavos" > 0),
	CONSTRAINT "payments_reference_required" CHECK ("payments"."method" = 'cash' OR coalesce("payments"."reference_no", '') <> '')
);
--> statement-breakpoint
CREATE TABLE "remittance_payments" (
	"remittance_id" uuid NOT NULL,
	"payment_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collector_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"expected_centavos" bigint NOT NULL,
	"remitted_centavos" bigint NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "remittances_amounts_nonneg" CHECK ("remittances"."expected_centavos" >= 0 AND "remittances"."remitted_centavos" >= 0)
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchises" ADD CONSTRAINT "franchises_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchises" ADD CONSTRAINT "franchises_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchises" ADD CONSTRAINT "franchises_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boundary_plans" ADD CONSTRAINT "boundary_plans_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boundary_plans" ADD CONSTRAINT "boundary_plans_account_id_driver_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."driver_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boundary_plans" ADD CONSTRAINT "boundary_plans_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boundary_plans" ADD CONSTRAINT "boundary_plans_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_accounts" ADD CONSTRAINT "driver_accounts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_accounts" ADD CONSTRAINT "driver_accounts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_driver_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."driver_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_plan_id_boundary_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."boundary_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_account_id_driver_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."driver_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collector_id_profiles_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_receipt_document_id_documents_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_payments" ADD CONSTRAINT "remittance_payments_remittance_id_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."remittances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittance_payments" ADD CONSTRAINT "remittance_payments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_collector_id_profiles_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_received_by_profiles_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drivers_name_idx" ON "drivers" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "drivers_status_idx" ON "drivers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "franchises_vehicle_idx" ON "franchises" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "franchises_expiry_idx" ON "franchises" USING btree ("expires_on");--> statement-breakpoint
CREATE INDEX "assignments_driver_idx" ON "vehicle_assignments" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_plate_uq" ON "vehicles" USING btree (upper("plate_no"));--> statement-breakpoint
CREATE INDEX "boundary_plans_driver_idx" ON "boundary_plans" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "charge_runs_to_idx" ON "charge_runs" USING btree ("to_date");--> statement-breakpoint
CREATE INDEX "driver_accounts_driver_idx" ON "driver_accounts" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_accounts_single_uq" ON "driver_accounts" USING btree ("driver_id","kind") WHERE "driver_accounts"."kind" IN ('boundary', 'charges');--> statement-breakpoint
CREATE UNIQUE INDEX "driver_accounts_contract_uq" ON "driver_accounts" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger_entries" USING btree ("account_id","due_date");--> statement-breakpoint
CREATE INDEX "ledger_driver_date_idx" ON "ledger_entries" USING btree ("driver_id","business_date");--> statement-breakpoint
CREATE INDEX "ledger_payment_idx" ON "ledger_entries" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_driver_idx" ON "payments" USING btree ("driver_id","business_date");--> statement-breakpoint
CREATE INDEX "payments_collector_idx" ON "payments" USING btree ("collector_id","business_date");--> statement-breakpoint
CREATE INDEX "remittances_collector_idx" ON "remittances" USING btree ("collector_id","business_date");
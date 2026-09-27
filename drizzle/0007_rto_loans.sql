CREATE TYPE "public"."loan_status" AS ENUM('active', 'paid_off', 'restructured');--> statement-breakpoint
CREATE TYPE "public"."rto_status" AS ENUM('active', 'completed', 'cashed_out', 'terminated');--> statement-breakpoint
CREATE SEQUENCE "public"."rto_contract_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "loan_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reverses_payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "loan_payments_reverses_payment_id_unique" UNIQUE("reverses_payment_id"),
	CONSTRAINT "loan_payment_sign" CHECK (("loan_payments"."reverses_payment_id" IS NULL AND "loan_payments"."amount_centavos" > 0) OR ("loan_payments"."reverses_payment_id" IS NOT NULL AND "loan_payments"."amount_centavos" < 0))
);
--> statement-breakpoint
CREATE TABLE "loan_schedule_lines" (
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_date" date NOT NULL,
	"opening_balance_centavos" bigint NOT NULL,
	"principal_centavos" bigint NOT NULL,
	"interest_centavos" bigint NOT NULL,
	"payment_centavos" bigint NOT NULL,
	"closing_balance_centavos" bigint NOT NULL,
	CONSTRAINT "loan_schedule_uq" UNIQUE("loan_id","seq"),
	CONSTRAINT "loan_line_math" CHECK ("loan_schedule_lines"."payment_centavos" = "loan_schedule_lines"."principal_centavos" + "loan_schedule_lines"."interest_centavos"
      AND "loan_schedule_lines"."closing_balance_centavos" = "loan_schedule_lines"."opening_balance_centavos" - "loan_schedule_lines"."principal_centavos")
);
--> statement-breakpoint
CREATE TABLE "rto_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_no" text DEFAULT ('RTO-' || lpad(nextval('rto_contract_seq')::text, 5, '0')) NOT NULL,
	"driver_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contract_price_centavos" bigint NOT NULL,
	"down_payment_centavos" bigint DEFAULT 0 NOT NULL,
	"term_months" integer DEFAULT 60 NOT NULL,
	"start_date" date NOT NULL,
	"first_due_date" date NOT NULL,
	"status" "rto_status" DEFAULT 'active' NOT NULL,
	"closed_on" date,
	"close_reason" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "rto_contracts_contract_no_unique" UNIQUE("contract_no"),
	CONSTRAINT "rto_contracts_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "rto_price_pos" CHECK ("rto_contracts"."contract_price_centavos" > 0),
	CONSTRAINT "rto_down_range" CHECK ("rto_contracts"."down_payment_centavos" >= 0 AND "rto_contracts"."down_payment_centavos" < "rto_contracts"."contract_price_centavos"),
	CONSTRAINT "rto_term_range" CHECK ("rto_contracts"."term_months" BETWEEN 1 AND 120),
	CONSTRAINT "rto_first_due_after_start" CHECK ("rto_contracts"."first_due_date" >= "rto_contracts"."start_date"),
	CONSTRAINT "rto_closed_consistent" CHECK (("rto_contracts"."status" = 'active') = ("rto_contracts"."closed_on" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "vehicle_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"lender" text NOT NULL,
	"principal_centavos" bigint NOT NULL,
	"annual_rate_bps" integer NOT NULL,
	"term_months" integer NOT NULL,
	"first_due_date" date NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "loan_principal_pos" CHECK ("vehicle_loans"."principal_centavos" > 0),
	CONSTRAINT "loan_rate_range" CHECK ("vehicle_loans"."annual_rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "loan_term_range" CHECK ("vehicle_loans"."term_months" BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_vehicle_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."vehicle_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_schedule_lines" ADD CONSTRAINT "loan_schedule_lines_loan_id_vehicle_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."vehicle_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rto_contracts" ADD CONSTRAINT "rto_contracts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rto_contracts" ADD CONSTRAINT "rto_contracts_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rto_contracts" ADD CONSTRAINT "rto_contracts_account_id_driver_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."driver_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rto_contracts" ADD CONSTRAINT "rto_contracts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rto_contracts" ADD CONSTRAINT "rto_contracts_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loans" ADD CONSTRAINT "vehicle_loans_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loans" ADD CONSTRAINT "vehicle_loans_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_loans" ADD CONSTRAINT "vehicle_loans_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_payments_loan_idx" ON "loan_payments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "rto_contracts_driver_idx" ON "rto_contracts" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "rto_contracts_vehicle_idx" ON "rto_contracts" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_loans_vehicle_idx" ON "vehicle_loans" USING btree ("vehicle_id");
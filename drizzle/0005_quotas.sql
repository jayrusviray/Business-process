CREATE TYPE "public"."bonus_payout_mode" AS ENUM('credit', 'cash');--> statement-breakpoint
CREATE TYPE "public"."quota_metric" AS ENUM('trips', 'earnings_centavos', 'boundary_days_paid');--> statement-breakpoint
CREATE TYPE "public"."quota_period" AS ENUM('monthly', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."quota_result_source" AS ENUM('manual', 'csv');--> statement-breakpoint
CREATE TABLE "bonus_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quota_result_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"payout_mode" "bonus_payout_mode" NOT NULL,
	"ledger_entry_id" uuid,
	"paid_on" date NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "bonus_awards_quota_result_id_unique" UNIQUE("quota_result_id"),
	CONSTRAINT "bonus_awards_amount_pos" CHECK ("bonus_awards"."amount_centavos" > 0),
	CONSTRAINT "bonus_awards_credit_has_entry" CHECK (("bonus_awards"."payout_mode" = 'credit') = ("bonus_awards"."ledger_entry_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "quota_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"value" bigint NOT NULL,
	"source" "quota_result_source" NOT NULL,
	"source_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "quota_results_driver_rule_period_uq" UNIQUE("driver_id","rule_id","period_start"),
	CONSTRAINT "quota_results_value_nonneg" CHECK ("quota_results"."value" >= 0),
	CONSTRAINT "quota_results_period" CHECK ("quota_results"."period_end" >= "quota_results"."period_start")
);
--> statement-breakpoint
CREATE TABLE "quota_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"metric" "quota_metric" NOT NULL,
	"period" "quota_period" DEFAULT 'monthly' NOT NULL,
	"threshold" bigint NOT NULL,
	"bonus_centavos" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "quota_rules_threshold_pos" CHECK ("quota_rules"."threshold" > 0),
	CONSTRAINT "quota_rules_bonus_nonneg" CHECK ("quota_rules"."bonus_centavos" >= 0),
	CONSTRAINT "quota_rules_active_needs_bonus" CHECK (NOT "quota_rules"."active" OR "quota_rules"."bonus_centavos" > 0)
);
--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD CONSTRAINT "bonus_awards_quota_result_id_quota_results_id_fk" FOREIGN KEY ("quota_result_id") REFERENCES "public"."quota_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD CONSTRAINT "bonus_awards_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD CONSTRAINT "bonus_awards_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD CONSTRAINT "bonus_awards_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD CONSTRAINT "bonus_awards_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_results" ADD CONSTRAINT "quota_results_rule_id_quota_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."quota_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_results" ADD CONSTRAINT "quota_results_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_results" ADD CONSTRAINT "quota_results_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_results" ADD CONSTRAINT "quota_results_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_rules" ADD CONSTRAINT "quota_rules_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_rules" ADD CONSTRAINT "quota_rules_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bonus_awards_driver_idx" ON "bonus_awards" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "quota_results_rule_period_idx" ON "quota_results" USING btree ("rule_id","period_start");
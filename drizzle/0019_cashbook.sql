CREATE TABLE "cash_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"payment_method" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "cash_accounts_kind" CHECK ("cash_accounts"."kind" IN ('cash', 'ewallet', 'bank', 'other')),
	CONSTRAINT "cash_accounts_method" CHECK ("cash_accounts"."payment_method" IS NULL OR "cash_accounts"."payment_method" IN ('cash', 'gcash', 'maya', 'bank_transfer', 'other')),
	CONSTRAINT "cash_accounts_name_nonblank" CHECK (btrim("cash_accounts"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "cash_reassignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "cash_reassignments_source" CHECK ("cash_reassignments"."source_type" IN ('payment', 'application_payment', 'commission_received', 'referral_commission', 'application_commission',
        'investor_payout', 'loan_payment', 'expense', 'cash_advance', 'cash_advance_settlement', 'bonus_award')),
	CONSTRAINT "cash_reassignments_reason" CHECK (btrim("cash_reassignments"."reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "cash_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"counted_centavos" bigint NOT NULL,
	"system_centavos" bigint NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "cash_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_date" date NOT NULL,
	"category" text NOT NULL,
	"account_id" uuid NOT NULL,
	"counter_account_id" uuid,
	"amount_centavos" bigint NOT NULL,
	"description" text NOT NULL,
	"counterparty" text DEFAULT '' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "cash_transactions_amount_pos" CHECK ("cash_transactions"."amount_centavos" > 0),
	CONSTRAINT "cash_transactions_category" CHECK ("cash_transactions"."category" IN ('opening_balance', 'platform_revenue', 'investor_capital', 'owner_capital', 'other_in', 'owner_withdrawal', 'other_out', 'transfer')),
	CONSTRAINT "cash_transactions_transfer_pair" CHECK (("cash_transactions"."category" = 'transfer') = ("cash_transactions"."counter_account_id" IS NOT NULL) AND "cash_transactions"."counter_account_id" IS DISTINCT FROM "cash_transactions"."account_id"),
	CONSTRAINT "cash_transactions_description" CHECK (btrim("cash_transactions"."description") <> '')
);
--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reassignments" ADD CONSTRAINT "cash_reassignments_account_id_cash_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reassignments" ADD CONSTRAINT "cash_reassignments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_account_id_cash_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_account_id_cash_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_counter_account_id_cash_accounts_id_fk" FOREIGN KEY ("counter_account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_transactions" ADD CONSTRAINT "cash_transactions_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_accounts_name_uq" ON "cash_accounts" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "cash_accounts_method_uq" ON "cash_accounts" USING btree ("payment_method");--> statement-breakpoint
CREATE INDEX "cash_reassignments_source_idx" ON "cash_reassignments" USING btree ("source_type","source_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_reconciliations_account_idx" ON "cash_reconciliations" USING btree ("account_id","as_of_date");--> statement-breakpoint
CREATE INDEX "cash_transactions_date_idx" ON "cash_transactions" USING btree ("entry_date");
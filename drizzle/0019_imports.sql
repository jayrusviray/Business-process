CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"as_of" date,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "import_batches_kind_file_uq" UNIQUE("kind","file_sha256"),
	CONSTRAINT "import_batches_kind" CHECK ("import_batches"."kind" IN ('vehicles', 'drivers', 'boundary_plans', 'rto_contracts', 'opening_balances', 'legacy_payments', 'employees', 'investors', 'leads')),
	CONSTRAINT "import_batches_rows" CHECK ("import_batches"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "legacy_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"method" "payment_method" DEFAULT 'cash' NOT NULL,
	"reference_no" text DEFAULT '' NOT NULL,
	"account" "account_kind",
	"notes" text DEFAULT '' NOT NULL,
	"batch_id" uuid NOT NULL,
	"line" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "legacy_payments_batch_line_uq" UNIQUE("batch_id","line"),
	CONSTRAINT "legacy_payments_amount_pos" CHECK ("legacy_payments"."amount_centavos" > 0)
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_payments" ADD CONSTRAINT "legacy_payments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_payments" ADD CONSTRAINT "legacy_payments_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_payments" ADD CONSTRAINT "legacy_payments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_created_idx" ON "import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "legacy_payments_driver_idx" ON "legacy_payments" USING btree ("driver_id","paid_on");
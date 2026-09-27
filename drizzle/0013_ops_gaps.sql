CREATE TYPE "public"."proof_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "collection_day_closes" (
	"business_date" date PRIMARY KEY NOT NULL,
	"boundary_charged_centavos" bigint NOT NULL,
	"collected_centavos" bigint NOT NULL,
	"cash_centavos" bigint NOT NULL,
	"remitted_centavos" bigint NOT NULL,
	"collectors" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"closed_by" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"account_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_no" text NOT NULL,
	"paid_on" date NOT NULL,
	"document_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" "proof_status" DEFAULT 'pending' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"payment_id" uuid,
	CONSTRAINT "payment_proofs_document_id_unique" UNIQUE("document_id"),
	CONSTRAINT "payment_proofs_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "payment_proofs_amount_pos" CHECK ("payment_proofs"."amount_centavos" > 0),
	CONSTRAINT "payment_proofs_not_cash" CHECK ("payment_proofs"."method" <> 'cash'),
	CONSTRAINT "payment_proofs_reference" CHECK (btrim("payment_proofs"."reference_no") <> ''),
	CONSTRAINT "payment_proofs_decision" CHECK (CASE "payment_proofs"."status"
        WHEN 'pending' THEN "payment_proofs"."decided_at" IS NULL AND "payment_proofs"."payment_id" IS NULL
        WHEN 'approved' THEN "payment_proofs"."decided_at" IS NOT NULL AND "payment_proofs"."payment_id" IS NOT NULL
        ELSE "payment_proofs"."decided_at" IS NOT NULL AND "payment_proofs"."payment_id" IS NULL AND coalesce("payment_proofs"."reject_reason", '') <> '' END)
);
--> statement-breakpoint
CREATE TABLE "vehicle_maintenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"description" text NOT NULL,
	"shop" text DEFAULT '' NOT NULL,
	"odometer_km" integer,
	"cost_centavos" bigint NOT NULL,
	"receipt_document_id" uuid,
	"expense_id" uuid,
	"driver_id" uuid,
	"ledger_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "vehicle_maintenance_expense_id_unique" UNIQUE("expense_id"),
	CONSTRAINT "vehicle_maintenance_ledger_entry_id_unique" UNIQUE("ledger_entry_id"),
	CONSTRAINT "vehicle_maintenance_cost_nonneg" CHECK ("vehicle_maintenance"."cost_centavos" >= 0),
	CONSTRAINT "vehicle_maintenance_odometer" CHECK ("vehicle_maintenance"."odometer_km" IS NULL OR "vehicle_maintenance"."odometer_km" >= 0),
	CONSTRAINT "vehicle_maintenance_charge_pair" CHECK ("vehicle_maintenance"."ledger_entry_id" IS NULL OR "vehicle_maintenance"."driver_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "collection_day_closes" ADD CONSTRAINT "collection_day_closes_closed_by_profiles_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_platform_accounts" ADD CONSTRAINT "driver_platform_accounts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_platform_accounts" ADD CONSTRAINT "driver_platform_accounts_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_platform_accounts" ADD CONSTRAINT "driver_platform_accounts_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_submitted_by_profiles_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_decided_by_profiles_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_receipt_document_id_documents_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_maintenance" ADD CONSTRAINT "vehicle_maintenance_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_platform_accounts_driver_idx" ON "driver_platform_accounts" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_platform_accounts_uq" ON "driver_platform_accounts" USING btree (lower("platform"),lower("account_ref"));--> statement-breakpoint
CREATE INDEX "payment_proofs_status_idx" ON "payment_proofs" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "payment_proofs_driver_idx" ON "payment_proofs" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "vehicle_maintenance_vehicle_idx" ON "vehicle_maintenance" USING btree ("vehicle_id","service_date");
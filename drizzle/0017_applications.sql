CREATE TYPE "public"."application_status_kind" AS ENUM('open', 'approved', 'completed', 'on_hold', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."client_kind" AS ENUM('person', 'company');--> statement-breakpoint
CREATE TYPE "public"."commission_mode" AS ENUM('fixed', 'percent');--> statement-breakpoint
CREATE TYPE "public"."powertrain" AS ENUM('ice', 'ev', 'hybrid');--> statement-breakpoint
ALTER TYPE "public"."app_role" ADD VALUE 'documentation';--> statement-breakpoint
CREATE SEQUENCE "public"."application_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "application_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"template_id" uuid,
	"document_id" uuid,
	"submitted_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "app_checklist_verified_pair" CHECK (("application_checklist_items"."verified_by" IS NULL) = ("application_checklist_items"."verified_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "application_commission_rules" (
	"type_key" text PRIMARY KEY NOT NULL,
	"mode" "commission_mode" NOT NULL,
	"amount_centavos" bigint DEFAULT 0 NOT NULL,
	"rate_bps" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "app_commission_rules_values" CHECK ("application_commission_rules"."amount_centavos" >= 0 AND "application_commission_rules"."rate_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "application_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"referrer_name" text NOT NULL,
	"referrer_phone" text DEFAULT '' NOT NULL,
	"mode" "commission_mode" NOT NULL,
	"base_centavos" bigint NOT NULL,
	"rate_bps" integer DEFAULT 0 NOT NULL,
	"amount_centavos" bigint NOT NULL,
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
	CONSTRAINT "application_commissions_amount_nonneg" CHECK ("application_commissions"."amount_centavos" >= 0 AND "application_commissions"."base_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "application_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "application_fees_amount_pos" CHECK ("application_fees"."amount_centavos" > 0)
);
--> statement-breakpoint
CREATE TABLE "application_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text DEFAULT ('AR-' || lpad(nextval('payment_receipt_seq')::text, 6, '0')) NOT NULL,
	"application_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_no" text,
	"bank_name" text,
	"received_on" date NOT NULL,
	"received_by" uuid NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"client_request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "application_payments_receipt_no_unique" UNIQUE("receipt_no"),
	CONSTRAINT "application_payments_client_request_id_unique" UNIQUE("client_request_id"),
	CONSTRAINT "application_payments_amount_pos" CHECK ("application_payments"."amount_centavos" > 0),
	CONSTRAINT "application_payments_reference" CHECK ("application_payments"."method" = 'cash' OR coalesce("application_payments"."reference_no", '') <> '')
);
--> statement-breakpoint
CREATE TABLE "application_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_key" text,
	"to_key" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_statuses" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" "application_status_kind" DEFAULT 'open' NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_types" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"service_line" "service_line" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_fee_centavos" bigint DEFAULT 0 NOT NULL,
	"public_form" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "application_types_fee_nonneg" CHECK ("application_types"."default_fee_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_no" text DEFAULT ('APP-' || lpad(nextval('application_no_seq')::text, 6, '0')) NOT NULL,
	"type_key" text NOT NULL,
	"client_id" uuid NOT NULL,
	"lead_id" uuid,
	"vehicle_id" uuid,
	"driver_id" uuid,
	"assigned_to" uuid,
	"status_key" text DEFAULT 'inquiry' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancel_reason" text,
	"reference_no" text DEFAULT '' NOT NULL,
	"filed_on" date,
	"source" text DEFAULT 'staff' NOT NULL,
	"referrer_name" text DEFAULT '' NOT NULL,
	"referrer_phone" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "applications_app_no_unique" UNIQUE("app_no"),
	CONSTRAINT "applications_source" CHECK ("applications"."source" IN ('staff', 'public'))
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_key" text NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "client_kind" DEFAULT 'person' NOT NULL,
	"name" text NOT NULL,
	"contact_person" text DEFAULT '' NOT NULL,
	"mobile" text DEFAULT '' NOT NULL,
	"mobile_e164" text,
	"email" text,
	"address" text DEFAULT '' NOT NULL,
	"tin" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"lead_id" uuid,
	"driver_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "clients_name_nonblank" CHECK (btrim("clients"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "powertrain" "powertrain" DEFAULT 'ice' NOT NULL;--> statement-breakpoint
-- Hand-ordered: carry the existing EV flag into powertrain before is_ev becomes a generated column.
UPDATE "vehicles" SET "powertrain" = 'ev' WHERE "is_ev";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN "is_ev";--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "is_ev" boolean GENERATED ALWAYS AS (powertrain = 'ev') STORED;--> statement-breakpoint
ALTER TABLE "franchises" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "conduction_sticker" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "orcr_expires_on" date;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "insurance_expires_on" date;--> statement-breakpoint
ALTER TABLE "application_checklist_items" ADD CONSTRAINT "application_checklist_items_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_checklist_items" ADD CONSTRAINT "application_checklist_items_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_checklist_items" ADD CONSTRAINT "application_checklist_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_checklist_items" ADD CONSTRAINT "application_checklist_items_verified_by_profiles_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_checklist_items" ADD CONSTRAINT "application_checklist_items_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_checklist_items" ADD CONSTRAINT "application_checklist_items_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commission_rules" ADD CONSTRAINT "application_commission_rules_type_key_application_types_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."application_types"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commission_rules" ADD CONSTRAINT "application_commission_rules_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commission_rules" ADD CONSTRAINT "application_commission_rules_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commissions" ADD CONSTRAINT "application_commissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commissions" ADD CONSTRAINT "application_commissions_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commissions" ADD CONSTRAINT "application_commissions_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_commissions" ADD CONSTRAINT "application_commissions_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_fees" ADD CONSTRAINT "application_fees_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_fees" ADD CONSTRAINT "application_fees_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_fees" ADD CONSTRAINT "application_fees_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_payments" ADD CONSTRAINT "application_payments_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_payments" ADD CONSTRAINT "application_payments_received_by_profiles_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_payments" ADD CONSTRAINT "application_payments_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_payments" ADD CONSTRAINT "application_payments_voided_by_profiles_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_changed_by_profiles_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_type_key_application_types_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."application_types"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_assigned_to_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_status_key_application_statuses_key_fk" FOREIGN KEY ("status_key") REFERENCES "public"."application_statuses"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_type_key_application_types_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."application_types"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_checklist_app_idx" ON "application_checklist_items" USING btree ("application_id","sort");--> statement-breakpoint
CREATE UNIQUE INDEX "application_commissions_app_uq" ON "application_commissions" USING btree ("application_id") WHERE "application_commissions"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "application_fees_app_idx" ON "application_fees" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "application_payments_app_idx" ON "application_payments" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "application_payments_date_idx" ON "application_payments" USING btree ("received_on");--> statement-breakpoint
CREATE INDEX "app_status_history_app_idx" ON "application_status_history" USING btree ("application_id","changed_at");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status_key");--> statement-breakpoint
CREATE INDEX "applications_client_idx" ON "applications" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "applications_type_idx" ON "applications" USING btree ("type_key","created_at");--> statement-breakpoint
CREATE INDEX "applications_assigned_idx" ON "applications" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "checklist_templates_type_idx" ON "checklist_templates" USING btree ("type_key","sort");--> statement-breakpoint
CREATE INDEX "clients_mobile_idx" ON "clients" USING btree ("mobile_e164");--> statement-breakpoint
CREATE INDEX "clients_name_idx" ON "clients" USING btree ("name");
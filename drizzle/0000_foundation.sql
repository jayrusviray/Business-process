CREATE TYPE "public"."app_role" AS ENUM('owner_admin', 'finance', 'operations', 'sales', 'driver', 'investor');--> statement-breakpoint
CREATE TYPE "public"."gov_agency" AS ENUM('sss', 'philhealth', 'pagibig', 'bir_wtax');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_pk" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_fields" text[]
);
--> statement-breakpoint
CREATE TABLE "document_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"purpose" text DEFAULT 'view' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"storage_path" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"is_sensitive" boolean DEFAULT true NOT NULL,
	"expires_on" date,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_storage_path_unique" UNIQUE("storage_path")
);
--> statement-breakpoint
CREATE TABLE "gov_contribution_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency" "gov_agency" NOT NULL,
	"effective_from" date NOT NULL,
	"config" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "gov_tables_agency_effective_uq" UNIQUE("agency","effective_from")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"status" "profile_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "app_role" NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_profiles_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gov_contribution_tables" ADD CONSTRAINT "gov_contribution_tables_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gov_contribution_tables" ADD CONSTRAINT "gov_contribution_tables_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_profiles_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_table_row_idx" ON "audit_log" USING btree ("table_name","row_pk");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "document_access_doc_idx" ON "document_access_log" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_type","owner_id");
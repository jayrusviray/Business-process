CREATE TYPE "public"."contact_method" AS ENUM('call', 'sms', 'messenger', 'viber', 'email');--> statement-breakpoint
CREATE TYPE "public"."lead_activity_kind" AS ENUM('note', 'call', 'message', 'inquiry', 'stage_change', 'assignment', 'follow_up_done', 'converted', 'import');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('facebook_page', 'messenger', 'fb_lead_ad', 'landing_page', 'referral', 'walk_in', 'tiktok', 'other');--> statement-breakpoint
CREATE TYPE "public"."lead_stage_kind" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."service_line" AS ENUM('franchise', 'activation', 'vehicle_program', 'fleet', 'investment', 'school', 'other');--> statement-breakpoint
CREATE TYPE "public"."site_section" AS ENUM('hero', 'service', 'audience', 'step', 'requirement', 'program', 'faq', 'school', 'privacy');--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" "lead_activity_kind" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "lead_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"assigned_to" uuid,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "lead_stages" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" "lead_stage_kind" DEFAULT 'open' NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mobile" text DEFAULT '' NOT NULL,
	"mobile_e164" text,
	"email" text,
	"fb_name" text DEFAULT '' NOT NULL,
	"source" "lead_source" NOT NULL,
	"interest" "service_line" DEFAULT 'other' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"preferred_contact" "contact_method",
	"message" text DEFAULT '' NOT NULL,
	"stage_key" text DEFAULT 'new' NOT NULL,
	"assigned_to" uuid,
	"referrer_name" text DEFAULT '' NOT NULL,
	"referrer_phone" text DEFAULT '' NOT NULL,
	"referrer_driver_id" uuid,
	"consent_at" timestamp with time zone,
	"external_ref" text,
	"lost_reason" text,
	"converted_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "leads_external_ref_unique" UNIQUE("external_ref"),
	CONSTRAINT "leads_name_nonblank" CHECK (btrim("leads"."name") <> ''),
	CONSTRAINT "leads_contact_required" CHECK ("leads"."mobile" <> '' OR coalesce("leads"."email", '') <> '' OR "leads"."fb_name" <> '')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"handled_by" uuid NOT NULL,
	"handled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"ip_hash" text NOT NULL,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section" "site_section" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"service_line" "service_line",
	"sort" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_assigned_to_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_done_by_profiles_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_key_lead_stages_key_fk" FOREIGN KEY ("stage_key") REFERENCES "public"."lead_stages"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_profiles_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_referrer_driver_id_drivers_id_fk" FOREIGN KEY ("referrer_driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_handled_by_profiles_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_submissions" ADD CONSTRAINT "public_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_blocks" ADD CONSTRAINT "site_blocks_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_blocks" ADD CONSTRAINT "site_blocks_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_activities_lead_idx" ON "lead_activities" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_followups_open_idx" ON "lead_followups" USING btree ("assigned_to","due_on") WHERE "lead_followups"."done_at" IS NULL;--> statement-breakpoint
CREATE INDEX "lead_followups_lead_idx" ON "lead_followups" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "leads_mobile_idx" ON "leads" USING btree ("mobile_e164");--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("stage_key");--> statement-breakpoint
CREATE INDEX "leads_assigned_idx" ON "leads" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "leads_created_idx" ON "leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "public_submissions_ip_idx" ON "public_submissions" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "site_blocks_section_idx" ON "site_blocks" USING btree ("section","sort");--> statement-breakpoint
CREATE UNIQUE INDEX "site_blocks_single_uq" ON "site_blocks" USING btree ("section") WHERE "site_blocks"."section" IN ('hero', 'privacy');
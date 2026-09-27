CREATE TYPE "public"."message_language" AS ENUM('en', 'taglish');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'sent', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reminder_trigger" AS ENUM('balance_weekly', 'missed_boundary', 'amortization_upcoming', 'amortization_missed', 'rto_milestone', 'license_expiry', 'manual');--> statement-breakpoint
CREATE TABLE "message_opt_outs" (
	"phone" text NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "message_opt_outs_phone_channel_pk" PRIMARY KEY("phone","channel")
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"language" "message_language" NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "message_templates_key_lang_uq" UNIQUE("key","language")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid,
	"to_phone" text NOT NULL,
	"trigger" "reminder_trigger" NOT NULL,
	"language" "message_language" NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text,
	"channel" text DEFAULT 'sms_manual' NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"cost_centavos" bigint DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"handled_at" timestamp with time zone,
	"handled_by" uuid,
	CONSTRAINT "messages_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "reminder_rules" (
	"trigger" "reminder_trigger" PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"weekday" integer,
	"offset_days" integer,
	"min_amount_centavos" bigint DEFAULT 0 NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "reminder_weekday" CHECK ("reminder_rules"."weekday" IS NULL OR "reminder_rules"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "reminder_offset" CHECK ("reminder_rules"."offset_days" IS NULL OR "reminder_rules"."offset_days" BETWEEN 0 AND 120)
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "preferred_language" "message_language" DEFAULT 'taglish' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_opt_outs" ADD CONSTRAINT "message_opt_outs_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_handled_by_profiles_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "messages_driver_idx" ON "messages" USING btree ("driver_id","created_at");
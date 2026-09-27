import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contactMethod, leadActivityKind, leadSource, leadStageKind, serviceLine, siteSection } from "./enums";
import { drivers } from "./fleet";
import { profiles } from "./foundation";

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => profiles.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => profiles.id),
};

/** CRM pipeline stages (configurable by owner/admin). Leads keep the stage key. */
export const leadStages = pgTable("lead_stages", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  kind: leadStageKind("kind").notNull().default("open"),
  sort: integer("sort").notNull().default(100),
  active: boolean("active").notNull().default(true),
});

/**
 * A prospect from Facebook, Messenger, the landing page, referrals… Personal data
 * (RA 10173): no generic audit trail on this table; history lives in
 * lead_activities, and an erasure request deletes the lead and its history.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** As entered, normalised to 09XXXXXXXXX when it is a PH mobile. */
    mobile: text("mobile").notNull().default(""),
    /** +639XXXXXXXXX for duplicate detection; null when not a PH mobile. */
    mobileE164: text("mobile_e164"),
    email: text("email"),
    fbName: text("fb_name").notNull().default(""),
    source: leadSource("source").notNull(),
    interest: serviceLine("interest").notNull().default("other"),
    location: text("location").notNull().default(""),
    preferredContact: contactMethod("preferred_contact"),
    message: text("message").notNull().default(""),
    stageKey: text("stage_key")
      .notNull()
      .default("new")
      .references(() => leadStages.key),
    assignedTo: uuid("assigned_to").references(() => profiles.id),
    referrerName: text("referrer_name").notNull().default(""),
    referrerPhone: text("referrer_phone").notNull().default(""),
    referrerDriverId: uuid("referrer_driver_id").references(() => drivers.id),
    /** When the person agreed to the privacy notice (public forms). */
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /** Idempotency for external sources, e.g. "fb:<leadgen id>". */
    externalRef: text("external_ref").unique(),
    lostReason: text("lost_reason"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    notes: text("notes").notNull().default(""),
    ...stamps,
  },
  (t) => [
    index("leads_mobile_idx").on(t.mobileE164),
    index("leads_stage_idx").on(t.stageKey),
    index("leads_assigned_idx").on(t.assignedTo),
    index("leads_created_idx").on(t.createdAt),
    check("leads_name_nonblank", sql`btrim(${t.name}) <> ''`),
    check("leads_contact_required", sql`${t.mobile} <> '' OR coalesce(${t.email}, '') <> '' OR ${t.fbName} <> ''`),
  ],
);

/** Timeline of a lead (append-only; removed only when the lead is erased). */
export const leadActivities = pgTable(
  "lead_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    kind: leadActivityKind("kind").notNull(),
    body: text("body").notNull().default(""),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [index("lead_activities_lead_idx").on(t.leadId, t.createdAt)],
);

/** Scheduled follow-ups per agent. Only the completion fields change. */
export const leadFollowups = pgTable(
  "lead_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    dueOn: date("due_on").notNull(),
    note: text("note").notNull().default(""),
    assignedTo: uuid("assigned_to").references(() => profiles.id),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: uuid("done_by").references(() => profiles.id),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [index("lead_followups_open_idx").on(t.assignedTo, t.dueOn).where(sql`${t.doneAt} IS NULL`), index("lead_followups_lead_idx").on(t.leadId)],
);

/** Data-subject requests handled (RA 10173). Holds no personal data. */
export const privacyRequests = pgTable("privacy_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  kind: text("kind").notNull(),
  notes: text("notes").notNull().default(""),
  handledBy: uuid("handled_by")
    .notNull()
    .references(() => profiles.id),
  handledAt: timestamp("handled_at", { withTimezone: true }).notNull().defaultNow(),
});

/** In-app notifications (new lead assigned, inquiry received…). */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Public form submissions, for rate limiting (IP is stored only as a salted hash). */
export const publicSubmissions = pgTable(
  "public_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    ipHash: text("ip_hash").notNull(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("public_submissions_ip_idx").on(t.ipHash, t.createdAt)],
);

/** Editable content blocks of the public website (services, requirements, FAQs…). */
export const siteBlocks = pgTable(
  "site_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    section: siteSection("section").notNull(),
    title: text("title").notNull(),
    /** Plain text. For requirements, one item per line. */
    body: text("body").notNull().default(""),
    serviceLine: serviceLine("service_line"),
    sort: integer("sort").notNull().default(100),
    active: boolean("active").notNull().default(true),
    ...stamps,
  },
  (t) => [index("site_blocks_section_idx").on(t.section, t.sort), uniqueIndex("site_blocks_single_uq").on(t.section).where(sql`${t.section} IN ('hero', 'privacy')`)],
);

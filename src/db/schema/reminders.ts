import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { messageLanguage, messageStatus, reminderTrigger } from "./enums";
import { drivers } from "./fleet";
import { profiles } from "./foundation";

/** Admin-editable message templates with {{variables}}, one per trigger per language. */
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    language: messageLanguage("language").notNull(),
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [unique("message_templates_key_lang_uq").on(t.key, t.language)],
);

/**
 * When a reminder is generated into the outbox. Owner (2026-09-27): no SMS gateway yet,
 * so staff send each message manually; the schedule decides WHEN it appears.
 *   weekday     0–6 (Sun–Sat) for weekly triggers
 *   offsetDays  days before (upcoming/expiry) or after (missed) the due date
 */
export const reminderRules = pgTable(
  "reminder_rules",
  {
    trigger: reminderTrigger("trigger").primaryKey(),
    active: boolean("active").notNull().default(true),
    weekday: integer("weekday"),
    offsetDays: integer("offset_days"),
    minAmountCentavos: bigint("min_amount_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    description: text("description").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    check("reminder_weekday", sql`${t.weekday} IS NULL OR ${t.weekday} BETWEEN 0 AND 6`),
    check("reminder_offset", sql`${t.offsetDays} IS NULL OR ${t.offsetDays} BETWEEN 0 AND 120`),
  ],
);

/** Every reminder ever generated, and what happened to it (the message log). */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: uuid("driver_id").references(() => drivers.id),
    toPhone: text("to_phone").notNull(),
    trigger: reminderTrigger("trigger").notNull(),
    language: messageLanguage("language").notNull(),
    body: text("body").notNull(),
    /** Prevents the same reminder being generated twice, e.g. "missed_boundary:{driver}:{date}". */
    dedupeKey: text("dedupe_key").unique(),
    channel: text("channel").notNull().default("sms_manual"),
    status: messageStatus("status").notNull().default("pending"),
    costCentavos: bigint("cost_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    handledBy: uuid("handled_by").references(() => profiles.id),
  },
  (t) => [
    index("messages_status_idx").on(t.status, t.createdAt),
    index("messages_driver_idx").on(t.driverId, t.createdAt),
  ],
);

/** Numbers that asked not to receive reminders (honoured at generation time). */
export const messageOptOuts = pgTable(
  "message_opt_outs",
  {
    phone: text("phone").notNull(),
    channel: text("channel").notNull().default("sms"),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [primaryKey({ columns: [t.phone, t.channel] })],
);

import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bonusPayoutMode, quotaMetric, quotaPeriod, quotaResultSource } from "./enums";
import { drivers } from "./fleet";
import { profiles } from "./foundation";
import { ledgerEntries } from "./ledger";

/**
 * Configurable quota → bonus rule, e.g. "200 rides in a month" (owner, 2026-09-27).
 * `threshold` is a count for trips/days, or centavos for earnings.
 */
export const quotaRules = pgTable(
  "quota_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    metric: quotaMetric("metric").notNull(),
    period: quotaPeriod("period").notNull().default("monthly"),
    threshold: bigint("threshold", { mode: "bigint" }).notNull(),
    bonusCentavos: bigint("bonus_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    active: boolean("active").notNull().default(false),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    check("quota_rules_threshold_pos", sql`${t.threshold} > 0`),
    check("quota_rules_bonus_nonneg", sql`${t.bonusCentavos} >= 0`),
    check("quota_rules_active_needs_bonus", sql`NOT ${t.active} OR ${t.bonusCentavos} > 0`),
  ],
);

/** A driver's measured value for one rule and period (manual entry or CSV import). */
export const quotaResults = pgTable(
  "quota_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => quotaRules.id),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    value: bigint("value", { mode: "bigint" }).notNull(),
    source: quotaResultSource("source").notNull(),
    sourceNote: text("source_note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    unique("quota_results_driver_rule_period_uq").on(t.driverId, t.ruleId, t.periodStart),
    index("quota_results_rule_period_idx").on(t.ruleId, t.periodStart),
    check("quota_results_value_nonneg", sql`${t.value} >= 0`),
    check("quota_results_period", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

/**
 * Bonus granted for a quota hit. Owner: paid in cash OR credited to the balance,
 * chosen per award. Credit → a bonus_credit ledger entry. Only `voided_*` may change.
 */
export const bonusAwards = pgTable(
  "bonus_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quotaResultId: uuid("quota_result_id")
      .notNull()
      .references(() => quotaResults.id)
      .unique(),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    payoutMode: bonusPayoutMode("payout_mode").notNull(),
    ledgerEntryId: uuid("ledger_entry_id").references(() => ledgerEntries.id),
    paidOn: date("paid_on").notNull(),
    reference: text("reference").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("bonus_awards_driver_idx").on(t.driverId),
    check("bonus_awards_amount_pos", sql`${t.amountCentavos} > 0`),
    check("bonus_awards_credit_has_entry", sql`(${t.payoutMode} = 'credit') = (${t.ledgerEntryId} IS NOT NULL)`),
  ],
);

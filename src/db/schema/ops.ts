import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { paymentMethod, proofStatus } from "./enums";
import { drivers, vehicles } from "./fleet";
import { documents, profiles } from "./foundation";
import { ledgerEntries, payments } from "./ledger";
import { expenses } from "./office";

/**
 * A payment screenshot (GCash/Maya/bank) submitted by a driver from the portal.
 * Nothing is posted to the ledger until finance approves it, which records a
 * normal payment (the proof id is its idempotency key). Only the decision
 * columns may change, once.
 */
export const paymentProofs = pgTable(
  "payment_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    /** Amount the driver says they sent. */
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    method: paymentMethod("method").notNull(),
    referenceNo: text("reference_no").notNull(),
    paidOn: date("paid_on").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id)
      .unique(),
    note: text("note").notNull().default(""),
    status: proofStatus("status").notNull().default("pending"),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => profiles.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by").references(() => profiles.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    paymentId: uuid("payment_id")
      .references(() => payments.id)
      .unique(),
  },
  (t) => [
    index("payment_proofs_status_idx").on(t.status, t.submittedAt),
    index("payment_proofs_driver_idx").on(t.driverId),
    check("payment_proofs_amount_pos", sql`${t.amountCentavos} > 0`),
    check("payment_proofs_not_cash", sql`${t.method} <> 'cash'`),
    check("payment_proofs_reference", sql`btrim(${t.referenceNo}) <> ''`),
    check(
      "payment_proofs_decision",
      sql`CASE ${t.status}
        WHEN 'pending' THEN ${t.decidedAt} IS NULL AND ${t.paymentId} IS NULL
        WHEN 'approved' THEN ${t.decidedAt} IS NOT NULL AND ${t.paymentId} IS NOT NULL
        ELSE ${t.decidedAt} IS NOT NULL AND ${t.paymentId} IS NULL AND coalesce(${t.rejectReason}, '') <> '' END`,
    ),
  ],
);

/**
 * Finance's end-of-day close. A snapshot of what was charged, collected and
 * remitted that day, per collector. Immutable; if payments change after the
 * close, the screen shows the difference against this snapshot.
 */
export const collectionDayCloses = pgTable("collection_day_closes", {
  businessDate: date("business_date").primaryKey(),
  boundaryChargedCentavos: bigint("boundary_charged_centavos", { mode: "bigint" }).notNull(),
  collectedCentavos: bigint("collected_centavos", { mode: "bigint" }).notNull(),
  cashCentavos: bigint("cash_centavos", { mode: "bigint" }).notNull(),
  remittedCentavos: bigint("remitted_centavos", { mode: "bigint" }).notNull(),
  /** Per-collector snapshot: [{ collectorId, name, payments, collected, cash, remitted, unremitted }] (centavos as strings). */
  collectors: jsonb("collectors").notNull(),
  notes: text("notes").notNull().default(""),
  closedBy: uuid("closed_by")
    .notNull()
    .references(() => profiles.id),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Service/repair history of a vehicle. The cost can be booked as a company
 * expense and/or charged to the driver at cost (owner rule: drivers bear all
 * costs). Voiding the record voids the expense and reverses the charge.
 */
export const vehicleMaintenance = pgTable(
  "vehicle_maintenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    serviceDate: date("service_date").notNull(),
    description: text("description").notNull(),
    shop: text("shop").notNull().default(""),
    odometerKm: integer("odometer_km"),
    costCentavos: bigint("cost_centavos", { mode: "bigint" }).notNull(),
    receiptDocumentId: uuid("receipt_document_id").references(() => documents.id),
    expenseId: uuid("expense_id")
      .references(() => expenses.id)
      .unique(),
    driverId: uuid("driver_id").references(() => drivers.id),
    ledgerEntryId: uuid("ledger_entry_id")
      .references(() => ledgerEntries.id)
      .unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("vehicle_maintenance_vehicle_idx").on(t.vehicleId, t.serviceDate),
    check("vehicle_maintenance_cost_nonneg", sql`${t.costCentavos} >= 0`),
    check("vehicle_maintenance_odometer", sql`${t.odometerKm} IS NULL OR ${t.odometerKm} >= 0`),
    check("vehicle_maintenance_charge_pair", sql`${t.ledgerEntryId} IS NULL OR ${t.driverId} IS NOT NULL`),
  ],
);

/** A driver's account on a ride-hailing platform (e.g. inDrive). */
export const driverPlatformAccounts = pgTable(
  "driver_platform_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    platform: text("platform").notNull(),
    accountRef: text("account_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [
    index("driver_platform_accounts_driver_idx").on(t.driverId),
    uniqueIndex("driver_platform_accounts_uq").on(sql`lower(${t.platform})`, sql`lower(${t.accountRef})`),
  ],
);

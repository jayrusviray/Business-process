import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accountKind, paymentMethod } from "./enums";
import { drivers } from "./fleet";
import { profiles } from "./foundation";

/**
 * One committed spreadsheet import (Phase 9 data migration). Append-only.
 * The same file (by SHA-256) can be imported once per kind. `summary` holds
 * counts, totals and per-line results ({ line, action, id }); no personal data.
 * Kinds are listed in src/lib/imports/kinds.ts (keep the check constraint in sync).
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    rowCount: integer("row_count").notNull(),
    /** Opening balances and legacy payments: the "as of" date. Plans: the default start date. */
    asOf: date("as_of"),
    summary: jsonb("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [
    unique("import_batches_kind_file_uq").on(t.kind, t.fileSha256),
    index("import_batches_created_idx").on(t.createdAt),
    check(
      "import_batches_kind",
      sql`${t.kind} IN ('vehicles', 'drivers', 'boundary_plans', 'rto_contracts', 'opening_balances', 'legacy_payments', 'employees', 'investors', 'leads')`,
    ),
    check("import_batches_rows", sql`${t.rowCount} >= 0`),
  ],
);

/**
 * Payments recorded in the old spreadsheets, kept for reference only ("before
 * go-live" on the driver page). They NEVER touch the ledger: the driver's net
 * history is already in the opening balance. Append-only.
 */
export const legacyPayments = pgTable(
  "legacy_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    paidOn: date("paid_on").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    method: paymentMethod("method").notNull().default("cash"),
    referenceNo: text("reference_no").notNull().default(""),
    /** What the old sheet says the payment was for (informational only). */
    account: accountKind("account"),
    notes: text("notes").notNull().default(""),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id),
    line: integer("line").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
  },
  (t) => [
    index("legacy_payments_driver_idx").on(t.driverId, t.paidOn),
    unique("legacy_payments_batch_line_uq").on(t.batchId, t.line),
    check("legacy_payments_amount_pos", sql`${t.amountCentavos} > 0`),
  ],
);

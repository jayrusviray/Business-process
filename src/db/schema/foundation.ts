import {
  bigint,
  boolean,
  bigserial,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { appRole, govAgency, profileStatus } from "./enums";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** One row per Supabase auth user. Created by a trigger on auth.users. */
export const profiles = pgTable("profiles", {
  id: uuid("id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull().default(""),
  email: text("email"),
  phone: text("phone"),
  status: profileStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: appRole("role").notNull(),
    grantedBy: uuid("granted_by").references(() => profiles.id),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/**
 * Append-only audit trail, written only by the `app.audit_row_change()` trigger.
 * Nobody (not even owner_admin) may update or delete rows.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tableName: text("table_name").notNull(),
    rowPk: text("row_pk").notNull(),
    action: text("action").notNull(), // INSERT | UPDATE | DELETE
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label"), // e.g. "cron:daily-charges" for system jobs
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    before: jsonb("before"),
    after: jsonb("after"),
    changedFields: text("changed_fields").array(),
  },
  (t) => [
    index("audit_log_table_row_idx").on(t.tableName, t.rowPk),
    index("audit_log_actor_idx").on(t.actorId),
    index("audit_log_occurred_idx").on(t.occurredAt),
  ],
);

/**
 * Scalar/structured settings (key → JSON). Each key's shape is validated by the
 * Zod registry in `src/lib/settings/registry.ts` before writes.
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description").notNull().default(""),
  updatedAt: updatedAt(),
  updatedBy: uuid("updated_by").references(() => profiles.id),
});

/**
 * Government contribution / withholding tables, versioned by effective date.
 * Payroll picks the row with the latest `effective_from <= period end`.
 * `config` shape is validated per agency in `src/lib/settings/gov-tables.ts`.
 */
export const govContributionTables = pgTable(
  "gov_contribution_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agency: govAgency("agency").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    config: jsonb("config").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
    createdBy: uuid("created_by").references(() => profiles.id),
    updatedAt: updatedAt(),
    updatedBy: uuid("updated_by").references(() => profiles.id),
  },
  (t) => [unique("gov_tables_agency_effective_uq").on(t.agency, t.effectiveFrom)],
);

/**
 * Metadata for files in the private `documents` storage bucket
 * (licenses, IDs, OR/CR, receipts…). Files are only ever served via
 * short-lived signed URLs, and every issuance is logged below.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerType: text("owner_type").notNull(), // driver | vehicle | application | expense | payment | employee
    ownerId: uuid("owner_id").notNull(),
    docType: text("doc_type").notNull(), // drivers_license | gov_id | or_cr | receipt | ...
    storagePath: text("storage_path").notNull().unique(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    isSensitive: boolean("is_sensitive").notNull().default(true),
    expiresOn: date("expires_on"),
    uploadedBy: uuid("uploaded_by").references(() => profiles.id),
    createdAt: createdAt(),
  },
  (t) => [index("documents_owner_idx").on(t.ownerType, t.ownerId)],
);

/** Data Privacy Act: every signed-URL issuance for a document is recorded. */
export const documentAccessLog = pgTable(
  "document_access_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    actorId: uuid("actor_id").notNull(),
    purpose: text("purpose").notNull().default("view"),
    accessedAt: timestamp("accessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("document_access_doc_idx").on(t.documentId)],
);

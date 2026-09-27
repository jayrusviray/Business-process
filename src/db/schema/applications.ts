import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, pgSequence, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { leads } from "./crm";
import { applicationStatusKind, clientKind, commissionMode, commissionStatus, paymentMethod, serviceLine } from "./enums";
import { drivers, vehicles } from "./fleet";
import { documents, profiles } from "./foundation";

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => profiles.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => profiles.id),
};
const voidCols = {
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: uuid("voided_by").references(() => profiles.id),
  voidReason: text("void_reason"),
};

/** A person or company TransRev files applications for (operators, drivers, fleet owners). */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: clientKind("kind").notNull().default("person"),
    name: text("name").notNull(),
    contactPerson: text("contact_person").notNull().default(""),
    mobile: text("mobile").notNull().default(""),
    mobileE164: text("mobile_e164"),
    email: text("email"),
    address: text("address").notNull().default(""),
    tin: text("tin").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** The lead this client came from, if any. */
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    driverId: uuid("driver_id").references(() => drivers.id),
    ...stamps,
  },
  (t) => [index("clients_mobile_idx").on(t.mobileE164), index("clients_name_idx").on(t.name), check("clients_name_nonblank", sql`btrim(${t.name}) <> ''`)],
);

/** Kinds of application (LTFRB PA/CPC, platform activation, vehicle acquisition, driver program…). Configurable. */
export const applicationTypes = pgTable("application_types", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  serviceLine: serviceLine("service_line").notNull(),
  description: text("description").notNull().default(""),
  /** Suggested service fee when an application is opened (0 = none set). */
  defaultFeeCentavos: bigint("default_fee_centavos", { mode: "bigint" }).notNull().default(sql`0`),
  /** Offered on the public /apply form. */
  publicForm: boolean("public_form").notNull().default(true),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(100),
}, (t) => [check("application_types_fee_nonneg", sql`${t.defaultFeeCentavos} >= 0`)]);

/** The status pipeline (configurable). `kind` is what reports count on. */
export const applicationStatuses = pgTable("application_statuses", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  kind: applicationStatusKind("kind").notNull().default("open"),
  sort: integer("sort").notNull().default(100),
  active: boolean("active").notNull().default(true),
});

/** Default document checklist per application type (copied into each application when it is opened). */
export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    typeKey: text("type_key")
      .notNull()
      .references(() => applicationTypes.key),
    label: text("label").notNull(),
    required: boolean("required").notNull().default(true),
    sort: integer("sort").notNull().default(100),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("checklist_templates_type_idx").on(t.typeKey, t.sort)],
);

export const applicationNoSeq = pgSequence("application_no_seq", { startWith: 1 });

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appNo: text("app_no")
      .notNull()
      .unique()
      .default(sql`('APP-' || lpad(nextval('application_no_seq')::text, 6, '0'))`),
    typeKey: text("type_key")
      .notNull()
      .references(() => applicationTypes.key),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    /** Driver profile created from (or linked to) an approved driver-program application. */
    driverId: uuid("driver_id").references(() => drivers.id),
    assignedTo: uuid("assigned_to").references(() => profiles.id),
    statusKey: text("status_key")
      .notNull()
      .default("inquiry")
      .references(() => applicationStatuses.key),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** First time the application reached an approved/completed status. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /** LTFRB case number, platform reference… */
    referenceNo: text("reference_no").notNull().default(""),
    filedOn: date("filed_on"),
    /** "staff" or "public" (the /apply form). */
    source: text("source").notNull().default("staff"),
    referrerName: text("referrer_name").notNull().default(""),
    referrerPhone: text("referrer_phone").notNull().default(""),
    notes: text("notes").notNull().default(""),
    ...stamps,
  },
  (t) => [
    index("applications_status_idx").on(t.statusKey),
    index("applications_client_idx").on(t.clientId),
    index("applications_type_idx").on(t.typeKey, t.createdAt),
    index("applications_assigned_idx").on(t.assignedTo),
    check("applications_source", sql`${t.source} IN ('staff', 'public')`),
  ],
);

export const applicationChecklistItems = pgTable(
  "application_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    label: text("label").notNull(),
    required: boolean("required").notNull().default(true),
    sort: integer("sort").notNull().default(100),
    templateId: uuid("template_id").references(() => checklistTemplates.id),
    documentId: uuid("document_id").references(() => documents.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => profiles.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    note: text("note").notNull().default(""),
    ...stamps,
  },
  (t) => [
    index("app_checklist_app_idx").on(t.applicationId, t.sort),
    check("app_checklist_verified_pair", sql`(${t.verifiedBy} IS NULL) = (${t.verifiedAt} IS NULL)`),
  ],
);

/** Every status change (written by a trigger; append-only). */
export const applicationStatusHistory = pgTable(
  "application_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    fromKey: text("from_key"),
    toKey: text("to_key").notNull(),
    note: text("note").notNull().default(""),
    changedBy: uuid("changed_by").references(() => profiles.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("app_status_history_app_idx").on(t.applicationId, t.changedAt)],
);

/** Fees charged on an application (service fee, government fees passed through…). Void-only. */
export const applicationFees = pgTable(
  "application_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    description: text("description").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    ...voidCols,
  },
  (t) => [index("application_fees_app_idx").on(t.applicationId), check("application_fees_amount_pos", sql`${t.amountCentavos} > 0`)],
);

/** Payments of application fees. Acknowledgement receipts share the AR-###### series with driver payments. */
export const applicationPayments = pgTable(
  "application_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptNo: text("receipt_no")
      .notNull()
      .unique()
      .default(sql`('AR-' || lpad(nextval('payment_receipt_seq')::text, 6, '0'))`),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    method: paymentMethod("method").notNull(),
    referenceNo: text("reference_no"),
    bankName: text("bank_name"),
    receivedOn: date("received_on").notNull(),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => profiles.id),
    notes: text("notes").notNull().default(""),
    /** Idempotency key from the form (double-submits post once). */
    clientRequestId: uuid("client_request_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => profiles.id),
    ...voidCols,
  },
  (t) => [
    index("application_payments_app_idx").on(t.applicationId),
    index("application_payments_date_idx").on(t.receivedOn),
    check("application_payments_amount_pos", sql`${t.amountCentavos} > 0`),
    check("application_payments_reference", sql`${t.method} = 'cash' OR coalesce(${t.referenceNo}, '') <> ''`),
  ],
);

/** Referral commission rule per application type (spec 4.11). None until the owner sets them. */
export const applicationCommissionRules = pgTable(
  "application_commission_rules",
  {
    typeKey: text("type_key")
      .primaryKey()
      .references(() => applicationTypes.key),
    mode: commissionMode("mode").notNull(),
    /** Fixed amount (mode = fixed). */
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull().default(sql`0`),
    /** Percent of the application's fees, in basis points (mode = percent). */
    rateBps: integer("rate_bps").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...stamps,
  },
  (t) => [check("app_commission_rules_values", sql`${t.amountCentavos} >= 0 AND ${t.rateBps} BETWEEN 0 AND 10000`)],
);

/** Commission owed to whoever referred an application, created when it is approved. */
export const applicationCommissions = pgTable(
  "application_commissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    referrerName: text("referrer_name").notNull(),
    referrerPhone: text("referrer_phone").notNull().default(""),
    mode: commissionMode("mode").notNull(),
    baseCentavos: bigint("base_centavos", { mode: "bigint" }).notNull(),
    rateBps: integer("rate_bps").notNull().default(0),
    amountCentavos: bigint("amount_centavos", { mode: "bigint" }).notNull(),
    status: commissionStatus("status").notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => profiles.id),
    paidOn: date("paid_on"),
    paidReference: text("paid_reference"),
    voidReason: text("void_reason"),
    ...stamps,
  },
  (t) => [
    uniqueIndex("application_commissions_app_uq").on(t.applicationId).where(sql`${t.status} <> 'void'`),
    check("application_commissions_amount_nonneg", sql`${t.amountCentavos} >= 0 AND ${t.baseCentavos} >= 0`),
  ],
);

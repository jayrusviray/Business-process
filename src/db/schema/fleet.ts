import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { driverStatus, franchiseKind, fundingSource, messageLanguage, powertrain, vehicleStatus } from "./enums";
import { profiles } from "./foundation";

const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => profiles.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => profiles.id),
};

export const drivers = pgTable(
  "drivers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Portal login (driver role). Null until the driver is given access. */
    profileId: uuid("profile_id").references(() => profiles.id).unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    address: text("address").notNull().default(""),
    birthdate: date("birthdate"),
    licenseNo: text("license_no"),
    licenseExpiry: date("license_expiry"),
    emergencyContactName: text("emergency_contact_name").notNull().default(""),
    emergencyContactPhone: text("emergency_contact_phone").notNull().default(""),
    status: driverStatus("status").notNull().default("applicant"),
    /** Language for SMS reminders. */
    preferredLanguage: messageLanguage("preferred_language").notNull().default("taglish"),
    notes: text("notes").notNull().default(""),
    ...audit,
  },
  (t) => [index("drivers_name_idx").on(t.lastName, t.firstName), index("drivers_status_idx").on(t.status)],
);

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plateNo: text("plate_no").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    year: integer("year"),
    color: text("color").notNull().default(""),
    powertrain: powertrain("powertrain").notNull().default("ice"),
    /** Derived from powertrain (EV vs ICE counts, profitability). */
    isEv: boolean("is_ev").generatedAlwaysAs(sql`powertrain = 'ev'`),
    conductionSticker: text("conduction_sticker").notNull().default(""),
    orcrExpiresOn: date("orcr_expires_on"),
    insuranceExpiresOn: date("insurance_expires_on"),
    region: text("region").notNull().default(""),
    platforms: text("platforms").array().notNull().default(sql`'{}'::text[]`),
    acquisitionCostCentavos: bigint("acquisition_cost_centavos", { mode: "bigint" }),
    acquiredOn: date("acquired_on"),
    fundingSource: fundingSource("funding_source").notNull().default("company"),
    /** FK to investors (added in migration 0012; kept as a plain column here to avoid a schema import cycle). */
    investorId: uuid("investor_id"),
    status: vehicleStatus("status").notNull().default("available"),
    notes: text("notes").notNull().default(""),
    ...audit,
  },
  (t) => [
    uniqueIndex("vehicles_plate_uq").on(sql`upper(${t.plateNo})`),
    check("vehicles_cost_nonneg", sql`${t.acquisitionCostCentavos} IS NULL OR ${t.acquisitionCostCentavos} >= 0`),
  ],
);

export const franchises = pgTable(
  "franchises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    operatorName: text("operator_name").notNull(),
    /** The client (operator) who holds it, for renewal follow-up. FK added in migration 0018. */
    clientId: uuid("client_id"),
    kind: franchiseKind("kind").notNull(),
    number: text("number").notNull(),
    issuedOn: date("issued_on"),
    expiresOn: date("expires_on"),
    ...audit,
  },
  (t) => [index("franchises_vehicle_idx").on(t.vehicleId), index("franchises_expiry_idx").on(t.expiresOn)],
);

/**
 * Who drove which vehicle when. `end_date` is inclusive; null = current.
 * Overlaps per vehicle and per driver are rejected by exclusion constraints.
 */
export const vehicleAssignments = pgTable(
  "vehicle_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    reason: text("reason").notNull().default(""),
    ...audit,
  },
  (t) => [
    index("assignments_driver_idx").on(t.driverId),
    check("assignments_dates", sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);

/** Days on which boundary is NOT charged (owner rule: every day except holidays). */
export const holidays = pgTable("holidays", {
  date: date("date").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => profiles.id),
});

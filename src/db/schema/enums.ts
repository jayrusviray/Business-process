import { pgEnum } from "drizzle-orm/pg-core";

/** Application roles. Keep in sync with `src/lib/auth/roles.ts`. */
export const appRole = pgEnum("app_role", [
  "owner_admin",
  "finance",
  "operations",
  "sales",
  "driver",
  "investor",
]);

export const profileStatus = pgEnum("profile_status", ["active", "disabled"]);

export const govAgency = pgEnum("gov_agency", [
  "sss",
  "philhealth",
  "pagibig",
  "bir_wtax",
]);

import { hasAnyRole, type Role } from "@/lib/auth/roles";
import { collectionSummary, dailyCollection, driverAging, driverStatement } from "./collections";
import { rtoPortfolioReport, vehicleReport } from "./fleet";
import { cashFlowReport, commissionReport, expenseReport, investorStatementReport, payrollRegisterReport, quotaBonusReport } from "./office";
import { applicationsReport, crmLeadsReport, salesReport } from "./sales";
import type { ReportDef } from "./types";

/** The 15 reports of the spec (§6). Roles mirror RLS on the data each one reads. */
export const REPORTS: ReportDef[] = [
  dailyCollection,
  collectionSummary,
  driverAging,
  driverStatement,
  quotaBonusReport,
  rtoPortfolioReport,
  vehicleReport,
  salesReport,
  applicationsReport,
  crmLeadsReport,
  expenseReport,
  payrollRegisterReport,
  commissionReport,
  investorStatementReport,
  cashFlowReport,
];

export function findReport(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

export function reportsForRoles(roles: readonly Role[]): ReportDef[] {
  return REPORTS.filter((r) => hasAnyRole(roles, r.roles));
}

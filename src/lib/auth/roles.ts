export const ROLES = ["owner_admin", "finance", "operations", "sales", "documentation", "driver", "investor"] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES = ["owner_admin", "finance", "operations", "sales", "documentation"] as const satisfies readonly Role[];

export const ROLE_LABELS: Record<Role, string> = {
  owner_admin: "Owner / Admin",
  finance: "Finance",
  operations: "Operations / Collector",
  sales: "Sales / CRM",
  documentation: "Documentation staff",
  driver: "Driver",
  investor: "Investor / Partner",
};

export function hasAnyRole(userRoles: readonly Role[], allowed: readonly Role[]): boolean {
  return userRoles.some((r) => allowed.includes(r));
}

export function isStaff(userRoles: readonly Role[]): boolean {
  return hasAnyRole(userRoles, STAFF_ROLES);
}

/** Where a user lands after sign-in. */
export function homePathFor(userRoles: readonly Role[]): string {
  if (isStaff(userRoles)) return "/app";
  if (userRoles.includes("driver")) return "/portal";
  if (userRoles.includes("investor")) return "/portal";
  return "/pending";
}

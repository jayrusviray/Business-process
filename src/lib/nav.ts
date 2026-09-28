import type { Role } from "./auth/roles";

export type NavItem = {
  href: string;
  label: string;
  roles: readonly Role[];
  /** Build phase that delivers the screen; placeholder until then. */
  phase: number;
  description?: string;
};
export type NavSection = { title: string; items: NavItem[] };

const A = "owner_admin" as const;
const F = "finance" as const;
const O = "operations" as const;
const S = "sales" as const;
const D = "documentation" as const;

/**
 * Single source of truth for staff navigation. UI hiding is a convenience only:
 * every screen also checks roles server-side, and RLS is the real gate.
 */
/** Highest build phase delivered so far; later modules show as placeholders. */
export const CURRENT_PHASE = 9;

export const NAV: NavSection[] = [
  {
    title: "Overview",
    items: [{ href: "/app", label: "Dashboard", roles: [A, F, O, S], phase: 1 }],
  },
  {
    title: "Fleet",
    items: [
      { href: "/app/drivers", label: "Drivers", roles: [A, F, O], phase: 2, description: "Driver profiles, documents, status and assigned vehicle." },
      { href: "/app/vehicles", label: "Vehicles", roles: [A, F, O], phase: 2, description: "Vehicle records, franchise status, funding source and assignment history." },
    ],
  },
  {
    title: "Money in",
    items: [
      { href: "/app/collections", label: "Collections", roles: [A, F, O], phase: 2, description: "Record payments, end-of-day bulk entry and collector remittances." },
      { href: "/app/rto", label: "RTO & amortization", roles: [A, F, O], phase: 4, description: "Rent-to-own contracts, monthly amortization dues and cashout quotes." },
      { href: "/app/quotas", label: "Quotas & bonuses", roles: [A, F, O], phase: 3, description: "Monthly ride quotas and bonus postings." },
      { href: "/app/commissions", label: "Commissions", roles: [A, F], phase: 6, description: "Referral commissions paid and commissions received." },
    ],
  },
  {
    title: "Office",
    items: [
      { href: "/app/loans", label: "Vehicle loans", roles: [A, F], phase: 4, description: "Bank/dealer loan schedules (diminishing balance) and payments." },
      { href: "/app/investors", label: "Investors", roles: [A, F], phase: 6, description: "Investor revenue share computations, payouts and statements." },
      { href: "/app/expenses", label: "Expenses", roles: [A, F], phase: 6, description: "Operating expenses, recurring bills and budget vs actual." },
      { href: "/app/payroll", label: "Payroll", roles: [A, F], phase: 6, description: "Semi-monthly payroll, government deductions, 13th month and payslips." },
      { href: "/app/cashbook", label: "Cash book", roles: [A, F], phase: 8, description: "Every inflow and outflow per account (cash, GCash, Maya, bank), running balances and monthly reconciliation." },
    ],
  },
  {
    title: "Growth",
    items: [
      { href: "/app/crm", label: "Leads (CRM)", roles: [A, O, S], phase: 7, description: "Leads from Facebook, Messenger, the website and walk-ins: pipeline and follow-ups." },
      { href: "/app/applications", label: "Applications", roles: [A, O, S, D, F], phase: 7, description: "PA/CPC, platform activation, vehicle acquisition and driver program applications." },
      { href: "/app/website", label: "Website", roles: [A, S], phase: 7, description: "Edit the public website: services, requirements, FAQs and the school page." },
      { href: "/app/reminders", label: "Reminders", roles: [A, F, O], phase: 5, description: "Daily reminder outbox (sent manually from your phone), templates, schedules and log." },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/app/reports", label: "Reports", roles: [A, F, O, S, D], phase: 8, description: "Collections, aging, RTO, sales, CRM, expenses, payroll, commissions, investors, cash flow and vehicles. Excel, PDF and print." },
      { href: "/app/import", label: "Import", roles: [A], phase: 9, description: "Bring in the old spreadsheets: vehicles, drivers, plans, contracts, opening balances and more, with a row-by-row preview." },
    ],
  },
  {
    title: "Admin",
    items: [
      { href: "/app/admin/users", label: "Users & roles", roles: [A], phase: 1 },
      { href: "/app/admin/settings", label: "Settings", roles: [A], phase: 1 },
      { href: "/app/admin/holidays", label: "Holidays", roles: [A, F, O], phase: 2 },
      { href: "/app/admin/audit", label: "Audit log", roles: [A, F], phase: 1 },
    ],
  },
];

export function navForRoles(roles: readonly Role[]): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => i.roles.some((r) => roles.includes(r))) })).filter(
    (s) => s.items.length > 0,
  );
}

export function findModule(slug: string): NavItem | undefined {
  return NAV.flatMap((s) => s.items).find((i) => i.href === `/app/m/${slug}`);
}

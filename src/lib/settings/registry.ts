import { z } from "zod";

/**
 * Every key in `app_settings` must be declared here. Writes are validated
 * against `schema`; a DB test asserts seeded values parse.
 * Add a key here AND seed it in a migration (ON CONFLICT DO NOTHING).
 */
export const settingsRegistry = {
  "company.profile": {
    label: "Company profile",
    group: "Company",
    schema: z.object({
      name: z.string().min(1).max(120),
      address: z.string().max(300),
      phone: z.string().max(40),
      email: z.union([z.literal(""), z.email()]),
    }),
  },
  "business.timezone": {
    label: "Business timezone",
    group: "Company",
    readOnly: true,
    schema: z.literal("Asia/Manila"),
  },
  "ledger.allocation_strategy": {
    label: "Payment allocation strategy",
    group: "Collections",
    schema: z.enum(["oldest_due_first"]),
  },
  "collections.penalties_enabled": {
    label: "Late penalties enabled",
    group: "Collections",
    schema: z.boolean(),
  },
  "collections.delinquency_missed_amortizations": {
    label: "Flag drivers after this many missed amortizations",
    group: "Collections",
    schema: z.number().int().min(1).max(24),
  },
  "collections.charge_catch_up_max_days": {
    label: "Daily charge job: max days to back-fill",
    group: "Collections",
    schema: z.number().int().min(1).max(366),
  },
  "rto.default_term_months": {
    label: "Default RTO term (months)",
    group: "RTO & loans",
    schema: z.number().int().min(1).max(120),
  },
  "rto.cashout_requires_clear_balances": {
    label: "Require boundary & costs to be fully paid before ownership transfer",
    group: "RTO & loans",
    schema: z.boolean(),
  },
  "loans.due_alert_days": {
    label: "Alert finance this many days before a loan due date",
    group: "RTO & loans",
    schema: z.number().int().min(0).max(60),
  },
  "payroll.frequency": {
    label: "Payroll frequency",
    group: "Payroll",
    schema: z.enum(["semi_monthly", "monthly"]),
  },
  "payroll.thirteenth_month_enabled": {
    label: "13th month pay",
    group: "Payroll",
    schema: z.boolean(),
  },
  "payroll.working_days_per_year": {
    label: "Working days per year (daily rate divisor)",
    group: "Payroll",
    schema: z.number().int().min(200).max(365),
  },
  "payroll.hours_per_day": {
    label: "Hours per working day",
    group: "Payroll",
    schema: z.number().int().min(1).max(12),
  },
  "payroll.premium_rates": {
    label: "Premium pay rates (basis points)",
    group: "Payroll",
    schema: z.object({
      overtime_bps: z.number().int().min(10000).max(40000),
      rest_or_special_day_bps: z.number().int().min(10000).max(40000),
      regular_holiday_bps: z.number().int().min(10000).max(40000),
      night_diff_bps: z.number().int().min(0).max(10000),
    }),
  },
  "payroll.pay_delay_days": {
    label: "Pay date: days after cut-off end",
    group: "Payroll",
    schema: z.number().int().min(0).max(15),
  },
  "payroll.ca_deduct_after_days": {
    label: "Deduct unliquidated cash advances after (days)",
    group: "Payroll",
    schema: z.number().int().min(0).max(90),
  },
  "payroll.thirteenth_month_tax_exempt_centavos": {
    label: "13th month tax exemption (centavos)",
    group: "Payroll",
    schema: z.number().int().min(0),
  },
  "commissions.referral_rate_bps": {
    label: "Referral commission (% of down payment, in bps)",
    group: "Commissions & investors",
    schema: z.number().int().min(0).max(10000),
  },
  "commissions.referral_wait_months": {
    label: "Referral commission payable after (months)",
    group: "Commissions & investors",
    schema: z.number().int().min(0).max(24),
  },
  "investors.boundary_days": {
    label: "Investor share: boundary days per month",
    group: "Commissions & investors",
    schema: z.number().int().min(1).max(31),
  },
  "messaging.mode": {
    label: "Reminder sending",
    group: "Messaging",
    schema: z.enum(["manual"]),
  },
  "sms.sender_name": {
    label: "SMS sender name",
    group: "Messaging",
    schema: z.string().min(1).max(11).nullable(),
  },
  "portal.max_pending_proofs": {
    label: "Max payment proofs a driver can have waiting for verification",
    group: "Collections",
    schema: z.number().int().min(1).max(50),
  },
  "alerts.consecutive_unpaid_days": {
    label: "Flag drivers with this many unpaid boundary days in a row",
    group: "Alerts",
    schema: z.number().int().min(1).max(365),
  },
  "alerts.balance_threshold_centavos": {
    label: "Flag drivers whose total balance reaches (centavos)",
    group: "Alerts",
    schema: z.number().int().min(0),
  },
  "alerts.license_expiry_days": {
    label: "Flag licences expiring within (days)",
    group: "Alerts",
    schema: z.number().int().min(0).max(365),
  },
  "reminders.quiet_hours": {
    label: "No reminders between (Manila time)",
    group: "Messaging",
    schema: z.object({
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    }),
  },
} as const satisfies Record<
  string,
  { label: string; group: string; readOnly?: boolean; schema: z.ZodType }
>;

export type SettingKey = keyof typeof settingsRegistry;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsRegistry)[K]["schema"]>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsRegistry, key);
}

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingsRegistry[key].schema.parse(value) as SettingValue<K>;
}

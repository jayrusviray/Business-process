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
  "collections.delinquency_flag_months": {
    label: "Flag drivers overdue for (months)",
    group: "Collections",
    schema: z.number().int().min(1).max(24),
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
  "sms.sender_name": {
    label: "SMS sender name",
    group: "Messaging",
    schema: z.string().min(1).max(11).nullable(),
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

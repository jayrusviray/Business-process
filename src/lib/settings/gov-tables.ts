import { z } from "zod";

/**
 * Config shapes for `gov_contribution_tables.config`, per agency.
 * Amounts are centavos (integers), rates are basis points (1% = 100).
 * The payroll engine (Phase 6) consumes these; nothing here is hardcoded in code.
 */
const centavos = z.number().int().nonnegative();
const bps = z.number().int().min(0).max(10_000);

export const govTableConfigSchemas = {
  sss: z.object({
    employee_rate_bps: bps,
    employer_rate_bps: bps,
    msc_min_centavos: centavos,
    msc_max_centavos: centavos,
    msc_step_centavos: centavos.positive(),
    ec_threshold_msc_centavos: centavos,
    ec_low_centavos: centavos,
    ec_high_centavos: centavos,
  }),
  philhealth: z.object({
    rate_bps: bps,
    floor_centavos: centavos,
    ceiling_centavos: centavos,
    employee_share_bps: bps,
  }),
  pagibig: z.object({
    employee_rate_bps: bps,
    employee_rate_low_bps: bps,
    low_threshold_centavos: centavos,
    employer_rate_bps: bps,
    max_fund_salary_centavos: centavos,
  }),
  bir_wtax: z.object({
    basis: z.literal("annual"),
    brackets: z
      .array(z.object({ over_centavos: centavos, base_tax_centavos: centavos, rate_bps: bps }))
      .min(1)
      .refine((b) => b.every((x, i) => i === 0 || x.over_centavos > b[i - 1].over_centavos), {
        message: "brackets must be sorted by over_centavos ascending",
      }),
  }),
} as const;

export type GovAgency = keyof typeof govTableConfigSchemas;
export const GOV_AGENCY_LABELS: Record<GovAgency, string> = {
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
  bir_wtax: "BIR withholding tax",
};

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, govContributionTables } from "@/db/schema";
import type { GovConfigs, PayrollSettings } from "@/lib/payroll";
import { parseSetting, type SettingKey, type SettingValue } from "@/lib/settings/registry";
import { MoneyRuleError } from "../money/errors";

export async function getSetting<K extends SettingKey>(tx: Tx, key: K): Promise<SettingValue<K>> {
  const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  if (!row) throw new MoneyRuleError(`Missing setting ${key}`);
  return parseSetting(key, row.value);
}

/** Payroll settings + the government tables in effect on `asOf` (latest effective_from ≤ asOf). */
export async function loadPayrollConfig(tx: Tx, asOf: string): Promise<{ settings: PayrollSettings; gov: GovConfigs; govIds: Record<string, string> }> {
  const [wd, hpd, rates] = await Promise.all([
    getSetting(tx, "payroll.working_days_per_year"),
    getSetting(tx, "payroll.hours_per_day"),
    getSetting(tx, "payroll.premium_rates"),
  ]);
  const rows = await tx
    .select()
    .from(govContributionTables)
    .where(and(inArray(govContributionTables.agency, ["sss", "philhealth", "pagibig", "bir_wtax"]), lte(govContributionTables.effectiveFrom, asOf)))
    .orderBy(desc(govContributionTables.effectiveFrom));
  const pick = (agency: string) => {
    const r = rows.find((x) => x.agency === agency);
    if (!r) throw new MoneyRuleError(`No ${agency.toUpperCase()} table is effective on ${asOf}. Add one under Settings.`);
    return r;
  };
  const sss = pick("sss"), ph = pick("philhealth"), hdmf = pick("pagibig"), tax = pick("bir_wtax");
  return {
    settings: {
      workingDaysPerYear: wd,
      hoursPerDay: hpd,
      rates: {
        overtimeBps: rates.overtime_bps,
        restOrSpecialDayBps: rates.rest_or_special_day_bps,
        regularHolidayBps: rates.regular_holiday_bps,
        nightDiffBps: rates.night_diff_bps,
      },
    },
    gov: { sss: sss.config, philhealth: ph.config, pagibig: hdmf.config, wtax: tax.config } as GovConfigs,
    govIds: { sss: sss.id, philhealth: ph.id, pagibig: hdmf.id, bir_wtax: tax.id },
  };
}

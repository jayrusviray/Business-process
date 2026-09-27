import { describe, expect, it } from "vitest";
import { pesos } from "./money";
import {
  annualIncomeTax,
  computePayrollLine,
  EMPTY_INPUTS,
  pagibigMonthly,
  parseDecimalUnits,
  payrollPeriod,
  philhealthMonthly,
  semiMonthlyWithholding,
  splitMonthly,
  sssMonthly,
  sssMsc,
  thirteenthMonth,
  type GovConfigs,
  type PayrollSettings,
} from "./payroll";

// Same values as the seeded government tables (drizzle/0002_seed_settings.sql).
const gov: GovConfigs = {
  sss: { employee_rate_bps: 500, employer_rate_bps: 1000, msc_min_centavos: 500000, msc_max_centavos: 3500000, msc_step_centavos: 50000, ec_threshold_msc_centavos: 1500000, ec_low_centavos: 1000, ec_high_centavos: 3000 },
  philhealth: { rate_bps: 500, floor_centavos: 1000000, ceiling_centavos: 10000000, employee_share_bps: 5000 },
  pagibig: { employee_rate_bps: 200, employee_rate_low_bps: 100, low_threshold_centavos: 150000, employer_rate_bps: 200, max_fund_salary_centavos: 1000000 },
  wtax: {
    basis: "annual",
    brackets: [
      { over_centavos: 0, base_tax_centavos: 0, rate_bps: 0 },
      { over_centavos: 25000000, base_tax_centavos: 0, rate_bps: 1500 },
      { over_centavos: 40000000, base_tax_centavos: 2250000, rate_bps: 2000 },
      { over_centavos: 80000000, base_tax_centavos: 10250000, rate_bps: 2500 },
      { over_centavos: 200000000, base_tax_centavos: 40250000, rate_bps: 3000 },
      { over_centavos: 800000000, base_tax_centavos: 220250000, rate_bps: 3500 },
    ],
  },
};
const settings: PayrollSettings = {
  workingDaysPerYear: 261,
  hoursPerDay: 8,
  rates: { overtimeBps: 12500, restOrSpecialDayBps: 13000, regularHolidayBps: 20000, nightDiffBps: 1000 },
};
const monthly30k = { basis: "monthly" as const, rate: pesos(30_000), allowance: BigInt(0), allowanceTaxable: false };

describe("government contributions", () => {
  it("SSS MSC rounds to the nearest ₱500 within 5,000–35,000", () => {
    expect(sssMsc(pesos(5_249), gov.sss)).toBe(pesos(5_000));
    expect(sssMsc(pesos(5_250), gov.sss)).toBe(pesos(5_500));
    expect(sssMsc(pesos(3_000), gov.sss)).toBe(pesos(5_000));
    expect(sssMsc(pesos(80_000), gov.sss)).toBe(pesos(35_000));
  });
  it("SSS 15% (EE 5%, ER 10%) + EC", () => {
    expect(sssMonthly(pesos(30_000), gov.sss)).toEqual({ msc: pesos(30_000), employee: pesos(1_500), employer: pesos(3_000), ec: pesos(30) });
    expect(sssMonthly(pesos(12_000), gov.sss).ec).toBe(pesos(10));
  });
  it("PhilHealth 5% with floor and ceiling, shared 50/50", () => {
    expect(philhealthMonthly(pesos(30_000), gov.philhealth)).toEqual({ premium: pesos(1_500), employee: pesos(750), employer: pesos(750) });
    expect(philhealthMonthly(pesos(8_000), gov.philhealth).premium).toBe(pesos(500));
    expect(philhealthMonthly(pesos(150_000), gov.philhealth).premium).toBe(pesos(5_000));
  });
  it("Pag-IBIG 2%/2% capped at the max fund salary", () => {
    expect(pagibigMonthly(pesos(30_000), gov.pagibig)).toEqual({ employee: pesos(200), employer: pesos(200) });
    expect(pagibigMonthly(pesos(1_500), gov.pagibig)).toEqual({ employee: pesos(15), employer: pesos(30) });
  });
  it("TRAIN annual tax brackets", () => {
    expect(annualIncomeTax(pesos(250_000), gov.wtax)).toBe(BigInt(0));
    expect(annualIncomeTax(pesos(400_000), gov.wtax)).toBe(pesos(22_500));
    expect(annualIncomeTax(pesos(800_000), gov.wtax)).toBe(pesos(102_500));
    expect(annualIncomeTax(pesos(2_000_000), gov.wtax)).toBe(pesos(402_500));
    expect(semiMonthlyWithholding(pesos(13_775), gov.wtax)).toBe(BigInt(50375)); // ₱503.75
    expect(semiMonthlyWithholding(pesos(10_000), gov.wtax)).toBe(BigInt(0));
  });
  it("monthly amounts split over two cut-offs without losing a centavo", () => {
    expect(splitMonthly(BigInt(101), 1) + splitMonthly(BigInt(101), 2)).toBe(BigInt(101));
  });
});

describe("computePayrollLine", () => {
  it("₱30,000/month, no absences: worked example", () => {
    const l = computePayrollLine(monthly30k, EMPTY_INPUTS, 1, settings, gov);
    expect(l).toMatchObject({
      dailyRate: BigInt(137931), // 30,000 × 12 ÷ 261 = 1,379.31
      basicPay: pesos(15_000),
      grossTaxable: pesos(15_000),
      sssEmployee: pesos(750),
      philhealthEmployee: pesos(375),
      pagibigEmployee: pesos(100),
      taxableIncome: pesos(13_775),
      withholdingTax: BigInt(50375),
      netPay: BigInt(1327125), // 15,000 − 1,225 − 503.75
    });
    expect(l.warnings).toEqual([]);
  });

  it("absences, lates, overtime, premiums and night differential", () => {
    const l = computePayrollLine(
      monthly30k,
      { ...EMPTY_INPUTS, daysAbsentHundredths: 150, minutesLate: 30, overtimeMinutes: 120, restOrSpecialMinutes: 480, regularHolidayMinutes: 480, nightDiffMinutes: 60 },
      2,
      settings,
      gov,
    );
    // hourly = 30,000×12 / 261 / 8 = 172.4137…
    expect(l.absenceDeduction).toBe(BigInt(206897)); // 1.5 days = 2,068.97
    expect(l.lateDeduction).toBe(BigInt(8621)); // 30 min = 86.21
    expect(l.overtimePay).toBe(BigInt(43103)); // 2h × 125% = 431.03
    // Rest/special 8h × 130% = 1,793.10; regular holiday 8h × (200% − 100%) = 1,379.31
    expect(l.premiumPay).toBe(BigInt(179310) + BigInt(137931));
    expect(l.nightDiffPay).toBe(BigInt(1724)); // 1h × 10% = 17.24
    expect(l.basicEarned).toBe(pesos(15_000) - BigInt(206897) - BigInt(8621));
  });

  it("daily-paid staff: days worked plus unworked regular holidays at 100%, worked holidays at 200%", () => {
    const daily = { basis: "daily" as const, rate: pesos(645), allowance: pesos(500), allowanceTaxable: false };
    const l = computePayrollLine(daily, { ...EMPTY_INPUTS, daysWorkedHundredths: 1100, unworkedRegularHolidays: 1, regularHolidayMinutes: 480 }, 1, settings, gov);
    expect(l.basicPay).toBe(pesos(645 * 11));
    expect(l.holidayPay).toBe(pesos(645));
    expect(l.premiumPay).toBe(pesos(1290));
    expect(l.nonTaxable).toBe(pesos(500)); // non-taxable allowance
    expect(l.monthlyEquivalent).toBe(BigInt(1402875)); // 645 × 261 ÷ 12
  });

  it("reimbursements are non-taxable; cash advances and other deductions reduce net only", () => {
    const base = computePayrollLine(monthly30k, EMPTY_INPUTS, 1, settings, gov);
    const l = computePayrollLine(
      monthly30k,
      { ...EMPTY_INPUTS, nonTaxableReimbursements: pesos(1_200), cashAdvanceDeduction: pesos(2_000), otherDeductions: pesos(300) },
      1,
      settings,
      gov,
    );
    expect(l.withholdingTax).toBe(base.withholdingTax);
    expect(l.netPay).toBe(base.netPay + pesos(1_200) - pesos(2_000) - pesos(300));
  });

  it("warns instead of paying a negative net", () => {
    const l = computePayrollLine(monthly30k, { ...EMPTY_INPUTS, cashAdvanceDeduction: pesos(50_000) }, 1, settings, gov);
    expect(l.netPay < BigInt(0)).toBe(true);
    expect(l.warnings[0]).toMatch(/negative/);
  });

  it("the two halves of a month add up to the full monthly contributions", () => {
    const a = computePayrollLine({ ...monthly30k, rate: BigInt(3_333_333) }, EMPTY_INPUTS, 1, settings, gov);
    const b = computePayrollLine({ ...monthly30k, rate: BigInt(3_333_333) }, EMPTY_INPUTS, 2, settings, gov);
    expect(a.basicPay + b.basicPay).toBe(BigInt(3_333_333));
    expect(a.sssEmployee + b.sssEmployee).toBe(sssMonthly(BigInt(3_333_333), gov.sss).employee);
  });
});

describe("helpers", () => {
  it("13th month = basic earned ÷ 12", () => {
    expect(thirteenthMonth(pesos(360_000))).toBe(pesos(30_000));
    expect(thirteenthMonth(BigInt(-1))).toBe(BigInt(0));
  });
  it("periods", () => {
    expect(payrollPeriod(2026, 2, 2)).toEqual({ start: "2026-02-16", end: "2026-02-28" });
    expect(payrollPeriod(2026, 10, 1)).toEqual({ start: "2026-10-01", end: "2026-10-15" });
  });
  it("parses hours/days without floats", () => {
    expect(parseDecimalUnits("1.5", 60)).toBe(90);
    expect(parseDecimalUnits("0.25", 100)).toBe(25);
    expect(parseDecimalUnits("", 60)).toBe(0);
    expect(() => parseDecimalUnits("-1", 60)).toThrow();
    expect(() => parseDecimalUnits("1.333", 60)).toThrow();
  });
});

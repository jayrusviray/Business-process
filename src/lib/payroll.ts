import { applyBps, divRound, ZERO, type Centavos } from "./money";

/**
 * Semi-monthly payroll (owner, 2026-09-27) with Philippine Labor Code defaults.
 * Every rate below comes from settings / versioned government tables; nothing
 * is hardcoded. All pay is computed with exact rational arithmetic and rounded
 * once per component (half-up to the centavo).
 *
 * Time inputs are integers to avoid floats: minutes for hours worked/late, and
 * hundredths of a day for day counts (1.5 days = 150).
 */

export type SalaryBasis = "monthly" | "daily";

export type PayrollSettings = {
  workingDaysPerYear: number; // monthly → daily rate divisor (default 261)
  hoursPerDay: number; // default 8
  rates: {
    overtimeBps: number; // regular-day overtime, 125%
    restOrSpecialDayBps: number; // work on a rest day or special non-working day, 130%
    regularHolidayBps: number; // work on a regular holiday, 200%
    nightDiffBps: number; // night shift differential, 10%
  };
};

export type SssConfig = {
  employee_rate_bps: number;
  employer_rate_bps: number;
  msc_min_centavos: number;
  msc_max_centavos: number;
  msc_step_centavos: number;
  ec_threshold_msc_centavos: number;
  ec_low_centavos: number;
  ec_high_centavos: number;
};
export type PhilhealthConfig = { rate_bps: number; floor_centavos: number; ceiling_centavos: number; employee_share_bps: number };
export type PagibigConfig = {
  employee_rate_bps: number;
  employee_rate_low_bps: number;
  low_threshold_centavos: number;
  employer_rate_bps: number;
  max_fund_salary_centavos: number;
};
export type WtaxConfig = { basis: "annual"; brackets: { over_centavos: number; base_tax_centavos: number; rate_bps: number }[] };
export type GovConfigs = { sss: SssConfig; philhealth: PhilhealthConfig; pagibig: PagibigConfig; wtax: WtaxConfig };

const B = (n: number | bigint) => BigInt(n);

// ---------------------------------------------------------------------------
// Government contributions (monthly amounts)
// ---------------------------------------------------------------------------

/** SSS monthly salary credit: nearest step (…,5,250 → 5,500), clamped to the table range. */
export function sssMsc(monthlyComp: Centavos, c: SssConfig): Centavos {
  const step = B(c.msc_step_centavos);
  let msc = ((monthlyComp + step / B(2)) / step) * step;
  if (msc < B(c.msc_min_centavos)) msc = B(c.msc_min_centavos);
  if (msc > B(c.msc_max_centavos)) msc = B(c.msc_max_centavos);
  return msc;
}

export function sssMonthly(monthlyComp: Centavos, c: SssConfig) {
  const msc = sssMsc(monthlyComp, c);
  return {
    msc,
    employee: applyBps(msc, c.employee_rate_bps),
    employer: applyBps(msc, c.employer_rate_bps),
    ec: msc < B(c.ec_threshold_msc_centavos) ? B(c.ec_low_centavos) : B(c.ec_high_centavos),
  };
}

export function philhealthMonthly(monthlyBasic: Centavos, c: PhilhealthConfig) {
  let base = monthlyBasic;
  if (base < B(c.floor_centavos)) base = B(c.floor_centavos);
  if (base > B(c.ceiling_centavos)) base = B(c.ceiling_centavos);
  const premium = applyBps(base, c.rate_bps);
  const employee = applyBps(premium, c.employee_share_bps);
  return { premium, employee, employer: premium - employee };
}

export function pagibigMonthly(monthlyComp: Centavos, c: PagibigConfig) {
  const base = monthlyComp > B(c.max_fund_salary_centavos) ? B(c.max_fund_salary_centavos) : monthlyComp;
  const eeRate = monthlyComp <= B(c.low_threshold_centavos) ? c.employee_rate_low_bps : c.employee_rate_bps;
  return { employee: applyBps(base, eeRate), employer: applyBps(base, c.employer_rate_bps) };
}

/** BIR annual income tax (TRAIN table) for an annual taxable income. */
export function annualIncomeTax(annualTaxable: Centavos, c: WtaxConfig): Centavos {
  if (annualTaxable <= ZERO) return ZERO;
  const bracket = [...c.brackets].reverse().find((b) => annualTaxable > B(b.over_centavos)) ?? c.brackets[0];
  return B(bracket.base_tax_centavos) + applyBps(annualTaxable - B(bracket.over_centavos), bracket.rate_bps);
}

/** Withholding for one semi-monthly period: annualise (×24), apply the annual table, de-annualise (÷24). */
export function semiMonthlyWithholding(periodTaxable: Centavos, c: WtaxConfig): Centavos {
  if (periodTaxable <= ZERO) return ZERO;
  return divRound(annualIncomeTax(periodTaxable * B(24), c), B(24));
}

/** Split a monthly amount over the two cut-offs ("half each"); the second half takes the odd centavo. */
export function splitMonthly(monthly: Centavos, half: 1 | 2): Centavos {
  const first = monthly / B(2);
  return half === 1 ? first : monthly - first;
}

// ---------------------------------------------------------------------------
// One employee, one semi-monthly period
// ---------------------------------------------------------------------------

export type EmployeePay = {
  basis: SalaryBasis;
  /** Monthly salary (monthly basis) or daily rate (daily basis). */
  rate: Centavos;
  /** Fixed allowance per cut-off. */
  allowance: Centavos;
  allowanceTaxable: boolean;
};

export type PayrollInputs = {
  daysWorkedHundredths: number; // daily basis only
  daysAbsentHundredths: number; // monthly basis only
  minutesLate: number;
  overtimeMinutes: number;
  restOrSpecialMinutes: number;
  regularHolidayMinutes: number;
  unworkedRegularHolidays: number; // daily basis: paid 100% if not worked
  nightDiffMinutes: number;
  otherTaxableEarnings: Centavos;
  nonTaxableReimbursements: Centavos; // travel/business expense reimbursements
  otherDeductions: Centavos;
  cashAdvanceDeduction: Centavos; // unliquidated cash advances
};

export const EMPTY_INPUTS: PayrollInputs = {
  daysWorkedHundredths: 0,
  daysAbsentHundredths: 0,
  minutesLate: 0,
  overtimeMinutes: 0,
  restOrSpecialMinutes: 0,
  regularHolidayMinutes: 0,
  unworkedRegularHolidays: 0,
  nightDiffMinutes: 0,
  otherTaxableEarnings: ZERO,
  nonTaxableReimbursements: ZERO,
  otherDeductions: ZERO,
  cashAdvanceDeduction: ZERO,
};

export type PayrollLine = {
  dailyRate: Centavos;
  monthlyEquivalent: Centavos;
  basicPay: Centavos;
  absenceDeduction: Centavos;
  lateDeduction: Centavos;
  holidayPay: Centavos;
  overtimePay: Centavos;
  premiumPay: Centavos;
  nightDiffPay: Centavos;
  allowance: Centavos;
  otherTaxableEarnings: Centavos;
  grossTaxable: Centavos;
  nonTaxable: Centavos;
  sssEmployee: Centavos;
  sssEmployer: Centavos;
  sssEc: Centavos;
  philhealthEmployee: Centavos;
  philhealthEmployer: Centavos;
  pagibigEmployee: Centavos;
  pagibigEmployer: Centavos;
  taxableIncome: Centavos;
  withholdingTax: Centavos;
  otherDeductions: Centavos;
  cashAdvanceDeduction: Centavos;
  netPay: Centavos;
  /** Basic salary actually earned (for 13th month): basic − absences − lates (+ unworked holidays for daily). */
  basicEarned: Centavos;
  warnings: string[];
};

export function computePayrollLine(emp: EmployeePay, inp: PayrollInputs, half: 1 | 2, s: PayrollSettings, gov: GovConfigs): PayrollLine {
  const warnings: string[] = [];
  const wd = B(s.workingDaysPerYear);
  const hpd = B(s.hoursPerDay);
  // Rational daily rate numerator/denominator so hourly amounts round only once.
  const [dNum, dDen] = emp.basis === "monthly" ? [emp.rate * B(12), wd] : [emp.rate, B(1)];
  const dailyRate = divRound(dNum, dDen);
  const monthlyEquivalent = emp.basis === "monthly" ? emp.rate : divRound(emp.rate * wd, B(12));
  /** amount for `minutes` at `bps` of the hourly rate */
  const timePay = (minutes: number, bps: number) => divRound(dNum * B(minutes) * B(bps), dDen * hpd * B(60) * B(10_000));
  const dayPay = (hundredths: number) => divRound(dNum * B(hundredths), dDen * B(100));

  const basicPay = emp.basis === "monthly" ? splitMonthly(emp.rate, half) : dayPay(inp.daysWorkedHundredths);
  const absenceDeduction = emp.basis === "monthly" ? dayPay(inp.daysAbsentHundredths) : ZERO;
  const lateDeduction = timePay(inp.minutesLate, 10_000);
  const holidayPay = emp.basis === "daily" ? dayPay(inp.unworkedRegularHolidays * 100) : ZERO;
  const overtimePay = timePay(inp.overtimeMinutes, s.rates.overtimeBps);
  // Monthly-paid staff are already paid for regular holidays in their salary, so
  // work on a regular holiday adds only the premium above 100%.
  const regHolBps = emp.basis === "monthly" ? s.rates.regularHolidayBps - 10_000 : s.rates.regularHolidayBps;
  const premiumPay = timePay(inp.restOrSpecialMinutes, s.rates.restOrSpecialDayBps) + timePay(inp.regularHolidayMinutes, regHolBps);
  const nightDiffPay = timePay(inp.nightDiffMinutes, s.rates.nightDiffBps);

  const taxableAllowance = emp.allowanceTaxable ? emp.allowance : ZERO;
  const grossTaxable =
    basicPay - absenceDeduction - lateDeduction + holidayPay + overtimePay + premiumPay + nightDiffPay + taxableAllowance + inp.otherTaxableEarnings;
  const nonTaxable = (emp.allowanceTaxable ? ZERO : emp.allowance) + inp.nonTaxableReimbursements;

  // Contributions are based on the monthly salary and split half per cut-off (owner: both cut-offs).
  const sss = sssMonthly(monthlyEquivalent, gov.sss);
  const ph = philhealthMonthly(monthlyEquivalent, gov.philhealth);
  const hdmf = pagibigMonthly(monthlyEquivalent, gov.pagibig);
  const sssEmployee = splitMonthly(sss.employee, half);
  const philhealthEmployee = splitMonthly(ph.employee, half);
  const pagibigEmployee = splitMonthly(hdmf.employee, half);

  const taxableIncome = grossTaxable - sssEmployee - philhealthEmployee - pagibigEmployee;
  const withholdingTax = semiMonthlyWithholding(taxableIncome, gov.wtax);
  const netPay =
    grossTaxable + nonTaxable - sssEmployee - philhealthEmployee - pagibigEmployee - withholdingTax - inp.otherDeductions - inp.cashAdvanceDeduction;
  if (netPay < ZERO) warnings.push("Net pay is negative: reduce deductions or carry them to the next cut-off.");
  if (grossTaxable < ZERO) warnings.push("Absences and lates exceed basic pay.");

  return {
    dailyRate,
    monthlyEquivalent,
    basicPay,
    absenceDeduction,
    lateDeduction,
    holidayPay,
    overtimePay,
    premiumPay,
    nightDiffPay,
    allowance: emp.allowance,
    otherTaxableEarnings: inp.otherTaxableEarnings,
    grossTaxable,
    nonTaxable,
    sssEmployee,
    sssEmployer: splitMonthly(sss.employer, half),
    sssEc: splitMonthly(sss.ec, half),
    philhealthEmployee,
    philhealthEmployer: splitMonthly(ph.employer, half),
    pagibigEmployee,
    pagibigEmployer: splitMonthly(hdmf.employer, half),
    taxableIncome,
    withholdingTax,
    otherDeductions: inp.otherDeductions,
    cashAdvanceDeduction: inp.cashAdvanceDeduction,
    netPay,
    basicEarned: basicPay - absenceDeduction - lateDeduction + holidayPay,
    warnings,
  };
}

/** 13th month pay = total basic salary earned in the calendar year ÷ 12 (PD 851). */
export function thirteenthMonth(basicEarnedInYear: Centavos): Centavos {
  return basicEarnedInYear <= ZERO ? ZERO : divRound(basicEarnedInYear, B(12));
}

/** Semi-monthly periods: 1–15 and 16–end of month. */
export function payrollPeriod(year: number, month: number, half: 1 | 2): { start: string; end: string } {
  const mm = String(month).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return half === 1 ? { start: `${year}-${mm}-01`, end: `${year}-${mm}-15` } : { start: `${year}-${mm}-16`, end: `${year}-${mm}-${last}` };
}

/** "1.5" hours → 90 minutes; "0.25" days → 25 hundredths. Rejects negatives and >2 decimals. */
export function parseDecimalUnits(input: string, unitsPerOne: number): number {
  const s = input.trim();
  if (s === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`"${input}" is not a valid number`);
  const [w, f = ""] = s.split(".");
  const hundredths = Number(w) * 100 + Number(f.padEnd(2, "0"));
  if ((hundredths * unitsPerOne) % 100 !== 0) throw new Error(`"${input}" is too precise`);
  return (hundredths * unitsPerOne) / 100;
}

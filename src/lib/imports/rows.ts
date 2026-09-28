/**
 * Row validation for spreadsheet imports: raw cells → typed rows, or a
 * row-level error. Pure (no DB): look-ups such as "does this driver exist"
 * happen in src/server/imports/service.ts. Duplicates inside one file are
 * caught here.
 */
import { splitName } from "../applications";
import { normalizeMobile } from "../crm";
import type { IsoDate } from "../dates";
import { ZERO, type Centavos } from "../money";
import { validateTerms } from "../rto";
import {
  cleanPlate,
  FieldError,
  parseChoice,
  parseImportDate,
  parseImportInt,
  parseImportPeso,
  parseYesNo,
  plateKey,
  splitList,
} from "./cells";

export type RawRow = { line: number; values: Record<string, string> };

export type RowContext = {
  today: IsoDate;
  /** Opening balances / legacy payments: the as-of date (≤ today). */
  asOf: IsoDate;
  /** Boundary plans without a start date start on this day (≥ today). */
  startDate: IsoDate;
  /** Excel workbook uses the 1904 date system (old Mac files). */
  date1904: boolean;
  /** Setting rto.default_term_months. */
  defaultTermMonths: number;
};

export type Validated<T> = { line: number; data?: T; error?: string; warnings: string[] };

type Get = (key: string) => string;

function getter(row: RawRow, cols: ReadonlyMap<string, string>): Get {
  return (key) => {
    const h = cols.get(key);
    return h ? (row.values[h] ?? "").trim() : "";
  };
}

function run<T>(row: RawRow, cols: ReadonlyMap<string, string>, fn: (get: Get, warn: (w: string) => void) => T): Validated<T> {
  const warnings: string[] = [];
  try {
    return { line: row.line, data: fn(getter(row, cols), (w) => warnings.push(w)), warnings };
  } catch (e) {
    if (e instanceof FieldError) return { line: row.line, error: e.message, warnings };
    throw e;
  }
}

/** Runs a cell parser and prefixes its error with the column name. */
function col<T>(key: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof FieldError) throw new FieldError(`${key}: ${e.message}`);
    throw e;
  }
}

function required(get: Get, key: string): string {
  const v = get(key);
  if (!v) throw new FieldError(`${key} is required`);
  return v;
}

function optDate(get: Get, key: string, ctx: RowContext): IsoDate | null {
  const v = get(key);
  return v ? col(key, () => parseImportDate(v, { date1904: ctx.date1904 })) : null;
}

function reqDate(get: Get, key: string, ctx: RowContext): IsoDate {
  const v = required(get, key);
  return col(key, () => parseImportDate(v, { date1904: ctx.date1904 }));
}

function optPeso(get: Get, key: string): Centavos | null {
  const v = get(key);
  return v ? col(key, () => parseImportPeso(v)) : null;
}

function reqPeso(get: Get, key: string): Centavos {
  return col(key, () => parseImportPeso(required(get, key)));
}

function optText(get: Get, key: string, max: number): string {
  const v = get(key);
  if (v.length > max) throw new FieldError(`${key} is too long (max ${max} characters)`);
  return v;
}

function mobileOf(get: Get, key = "mobile"): string {
  const raw = required(get, key);
  const m = normalizeMobile(raw);
  if (!m.e164) throw new FieldError(`${key}: "${raw}" is not a PH mobile number (e.g. 0917 123 4567)`);
  return m.mobile;
}

function email(get: Get): string | null {
  const v = get("email");
  if (!v) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new FieldError(`email: "${v}" is not a valid email`);
  return v;
}

function personName(get: Get): { firstName: string; lastName: string } {
  let firstName = get("first_name");
  let lastName = get("last_name");
  if (!firstName && !lastName) ({ firstName, lastName } = splitName(get("name")));
  if (!firstName || !lastName) throw new FieldError("give the first and last name (or a full name)");
  if (firstName.length > 80 || lastName.length > 80) throw new FieldError("name is too long");
  return { firstName, lastName };
}

/** Flags rows whose key repeats an earlier row (first occurrence wins). */
function flagDuplicates<T>(rows: Validated<T>[], keyOf: (d: T) => string | null, message: (line: number) => string): void {
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.data) continue;
    const k = keyOf(r.data);
    if (!k) continue;
    const first = seen.get(k);
    if (first !== undefined) {
      r.error = message(first);
      delete r.data;
    } else seen.set(k, r.line);
  }
}

// ---------------------------------------------------------------------------
// Choice lists (lowercase; spaces, dashes and underscores compare as one space)
// ---------------------------------------------------------------------------
const POWERTRAIN = {
  ice: "ice", gas: "ice", gasoline: "ice", diesel: "ice", petrol: "ice", fuel: "ice",
  ev: "ev", electric: "ev", bev: "ev",
  hybrid: "hybrid", hev: "hybrid", phev: "hybrid",
} as const;
const FUNDING = {
  company: "company", own: "company", owned: "company", transrev: "company",
  investor: "investor",
  financed: "financed", bank: "financed", loan: "financed", dealer: "financed", "bank loan": "financed",
} as const;
const VEHICLE_STATUS = {
  available: "available", active: "available", assigned: "available",
  maintenance: "maintenance", repair: "maintenance", "under repair": "maintenance",
  retired: "retired", sold: "retired",
  transferred: "transferred",
} as const;
const DRIVER_STATUS = {
  active: "active", suspended: "suspended", "on hold": "suspended", applicant: "applicant",
  completed: "completed", terminated: "terminated", resigned: "terminated",
} as const;
const LANGUAGE = { taglish: "taglish", tagalog: "taglish", filipino: "taglish", fil: "taglish", tl: "taglish", en: "en", english: "en" } as const;
const PROGRAM = {
  boundary: "boundary",
  rto: "rto", "rent to own": "rto", hulog: "rto", "boundary hulog": "rto", "hulog boundary": "rto",
} as const;
const ACCOUNT = {
  boundary: "boundary",
  charges: "charges", charge: "charges", costs: "charges", cost: "charges", deposit: "charges", "costs & deposit": "charges", "costs and deposit": "charges",
  amortization: "amortization", amortisation: "amortization", amort: "amortization", rto: "amortization", hulog: "amortization",
} as const;
const METHOD = {
  cash: "cash",
  gcash: "gcash", "g cash": "gcash",
  maya: "maya", paymaya: "maya", "pay maya": "maya",
  bank: "bank_transfer", "bank transfer": "bank_transfer", "bank deposit": "bank_transfer", deposit: "bank_transfer", online: "bank_transfer",
  instapay: "bank_transfer", pesonet: "bank_transfer", bdo: "bank_transfer", bpi: "bank_transfer",
  other: "other", others: "other", check: "other", cheque: "other",
} as const;
const BASIS = { monthly: "monthly", month: "monthly", "per month": "monthly", daily: "daily", day: "daily", "per day": "daily" } as const;
const EMPLOYEE_STATUS = { active: "active", inactive: "inactive", resigned: "inactive", separated: "inactive" } as const;

function choice<T extends string>(get: Get, key: string, aliases: Record<string, T>, what: string, fallback: T): T {
  const v = get(key);
  return v ? col(key, () => parseChoice(v, aliases, what)) : fallback;
}

export type AccountKind = "boundary" | "amortization" | "charges";
export type PaymentMethod = "cash" | "gcash" | "maya" | "bank_transfer" | "other";

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
export type VehicleRow = {
  plateNo: string;
  plateKey: string;
  make: string;
  model: string;
  year: number | null;
  color: string;
  powertrain: "ice" | "ev" | "hybrid";
  region: string;
  conductionSticker: string;
  orcrExpiresOn: IsoDate | null;
  insuranceExpiresOn: IsoDate | null;
  platforms: string[];
  acquisitionCost: Centavos | null;
  acquiredOn: IsoDate | null;
  fundingSource: "company" | "investor" | "financed";
  status: "available" | "maintenance" | "retired" | "transferred";
  notes: string;
};

export function validateVehicleRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<VehicleRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get, warn) => {
      const plateNo = cleanPlate(required(get, "plate_no"));
      if (plateKey(plateNo).length < 2 || plateNo.length > 20) throw new FieldError(`plate_no: "${plateNo}" is not a plate number`);
      const make = required(get, "make");
      const model = required(get, "model");
      if (make.length > 60 || model.length > 60) throw new FieldError("make/model is too long (max 60 characters)");
      const yearText = get("year");
      const cost = optPeso(get, "acquisition_cost");
      if (cost !== null && cost < ZERO) throw new FieldError("acquisition_cost can't be negative");
      const statusText = get("status");
      if (/^assigned$/i.test(statusText)) warn("Status set to available: the boundary plans import assigns it to its driver.");
      return {
        plateNo,
        plateKey: plateKey(plateNo),
        make,
        model,
        year: yearText ? col("year", () => parseImportInt(yearText, 1990, 2100)) : null,
        color: optText(get, "color", 40),
        powertrain: choice(get, "powertrain", POWERTRAIN, "type", "ice"),
        region: optText(get, "region", 80),
        conductionSticker: optText(get, "conduction_sticker", 40),
        orcrExpiresOn: optDate(get, "orcr_expires_on", ctx),
        insuranceExpiresOn: optDate(get, "insurance_expires_on", ctx),
        platforms: splitList(get("platforms")),
        acquisitionCost: cost !== null && cost > ZERO ? cost : null,
        acquiredOn: optDate(get, "acquired_on", ctx),
        fundingSource: choice(get, "funding_source", FUNDING, "funding source", "company"),
        status: choice(get, "status", VEHICLE_STATUS, "vehicle status", "available"),
        notes: optText(get, "notes", 2000),
      };
    }),
  );
  flagDuplicates(out, (d) => d.plateKey, (l) => `Same plate as line ${l}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
export type DriverRow = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  address: string;
  birthdate: IsoDate | null;
  licenseNo: string | null;
  licenseExpiry: IsoDate | null;
  emergencyContactName: string;
  emergencyContactPhone: string;
  status: "applicant" | "active" | "suspended" | "completed" | "terminated";
  preferredLanguage: "en" | "taglish";
  notes: string;
};

export function validateDriverRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<DriverRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get) => {
      const { firstName, lastName } = personName(get);
      const birthdate = optDate(get, "birthdate", ctx);
      if (birthdate && birthdate >= ctx.today) throw new FieldError("birthdate must be in the past");
      return {
        firstName,
        lastName,
        phone: mobileOf(get),
        email: email(get),
        address: optText(get, "address", 300),
        birthdate,
        licenseNo: optText(get, "license_no", 40) || null,
        licenseExpiry: optDate(get, "license_expiry", ctx),
        emergencyContactName: optText(get, "emergency_contact_name", 120),
        emergencyContactPhone: optText(get, "emergency_contact_phone", 40),
        status: choice(get, "status", DRIVER_STATUS, "driver status", "active"),
        preferredLanguage: choice(get, "language", LANGUAGE, "language", "taglish"),
        notes: optText(get, "notes", 2000),
      };
    }),
  );
  flagDuplicates(out, (d) => d.phone, (l) => `Same mobile number as line ${l}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Boundary plans
// ---------------------------------------------------------------------------
export type PlanRow = {
  mobile: string;
  driverName: string;
  plateNo: string | null;
  plateKey: string | null;
  programType: "boundary" | "rto";
  dailyRate: Centavos;
  startDate: IsoDate;
  notes: string;
};

export function validatePlanRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<PlanRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get) => {
      const plate = get("plate_no");
      const dailyRate = reqPeso(get, "daily_rate");
      if (dailyRate <= ZERO) throw new FieldError("daily_rate must be more than ₱0.00");
      const startDate = optDate(get, "start_date", ctx) ?? ctx.startDate;
      if (startDate < ctx.today) {
        throw new FieldError(
          `start_date ${startDate} is in the past. Plans start on go-live day or later; put the history in the opening balances.`,
        );
      }
      return {
        mobile: mobileOf(get),
        driverName: get("driver_name"),
        plateNo: plate ? cleanPlate(plate) : null,
        plateKey: plate ? plateKey(plate) : null,
        programType: choice(get, "program", PROGRAM, "program", "boundary"),
        dailyRate,
        startDate,
        notes: optText(get, "notes", 1000),
      };
    }),
  );
  flagDuplicates(out, (d) => d.mobile, (l) => `Same driver as line ${l} (one plan per driver).`);
  flagDuplicates(out, (d) => d.plateKey, (l) => `Same vehicle as line ${l}.`);
  return out;
}

// ---------------------------------------------------------------------------
// RTO contracts
// ---------------------------------------------------------------------------
export type ContractRow = {
  mobile: string;
  driverName: string;
  plateNo: string;
  plateKey: string;
  contractPrice: Centavos;
  downPayment: Centavos;
  termMonths: number;
  startDate: IsoDate;
  firstDueDate: IsoDate;
  paidToDate: Centavos;
  oldContractNo: string;
  notes: string;
};

export function validateContractRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<ContractRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get) => {
      const plate = required(get, "plate_no");
      const termText = get("term_months");
      const row: ContractRow = {
        mobile: mobileOf(get),
        driverName: get("driver_name"),
        plateNo: cleanPlate(plate),
        plateKey: plateKey(plate),
        contractPrice: reqPeso(get, "contract_price"),
        downPayment: optPeso(get, "down_payment") ?? ZERO,
        termMonths: termText ? col("term_months", () => parseImportInt(termText, 1, 120)) : ctx.defaultTermMonths,
        startDate: reqDate(get, "start_date", ctx),
        firstDueDate: reqDate(get, "first_due_date", ctx),
        paidToDate: optPeso(get, "paid_to_date") ?? ZERO,
        oldContractNo: optText(get, "contract_no", 60),
        notes: optText(get, "notes", 1000),
      };
      const invalid = validateTerms(row);
      if (invalid) throw new FieldError(invalid);
      if (row.paidToDate < ZERO) throw new FieldError("paid_to_date can't be negative");
      if (row.paidToDate > row.contractPrice) throw new FieldError("paid_to_date is more than the contract price");
      return row;
    }),
  );
  flagDuplicates(out, (d) => d.mobile, (l) => `Same driver as line ${l} (one active contract per driver).`);
  flagDuplicates(out, (d) => d.plateKey, (l) => `Same vehicle as line ${l}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------------
export type OpeningBalanceRow = {
  mobile: string;
  driverName: string;
  account: AccountKind;
  /** Positive = the driver owes; negative = credit. Never zero. */
  amount: Centavos;
  /** Debits only; null = the as-of date. */
  dueDate: IsoDate | null;
  contractNo: string;
  notes: string;
};

export function validateOpeningBalanceRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<OpeningBalanceRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get) => {
      const account = col("account", () => parseChoice(required(get, "account"), ACCOUNT, "account"));
      const amount = reqPeso(get, "amount");
      if (amount === ZERO) throw new FieldError("amount is zero: leave the row out");
      const dueDate = optDate(get, "due_date", ctx);
      if (dueDate && dueDate > ctx.asOf) throw new FieldError(`due_date ${dueDate} is after the as-of date ${ctx.asOf}`);
      return {
        mobile: mobileOf(get),
        driverName: get("driver_name"),
        account,
        amount,
        dueDate: amount > ZERO ? dueDate : null,
        contractNo: get("contract_no").toUpperCase(),
        notes: optText(get, "notes", 300),
      };
    }),
  );
  const seen = new Map<string, number>();
  for (const r of out) {
    if (!r.data) continue;
    const k = `${r.data.mobile}|${r.data.account}|${r.data.amount}|${r.data.dueDate ?? ""}`;
    const first = seen.get(k);
    if (first !== undefined) r.warnings.push(`Same driver, account, amount and due date as line ${first}: check it is not a duplicate.`);
    else seen.set(k, r.line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payments before go-live (reference only)
// ---------------------------------------------------------------------------
export type LegacyPaymentRow = {
  mobile: string;
  driverName: string;
  paidOn: IsoDate;
  amount: Centavos;
  method: PaymentMethod;
  referenceNo: string;
  account: AccountKind | null;
  notes: string;
};

export function validateLegacyPaymentRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<LegacyPaymentRow>[] {
  return rows.map((r) =>
    run(r, cols, (get) => {
      const paidOn = reqDate(get, "paid_on", ctx);
      if (paidOn > ctx.asOf) throw new FieldError(`paid_on ${paidOn} is after the as-of date ${ctx.asOf}; record it as a normal payment instead`);
      const amount = reqPeso(get, "amount");
      if (amount <= ZERO) throw new FieldError("amount must be more than ₱0.00");
      const acct = get("account");
      return {
        mobile: mobileOf(get),
        driverName: get("driver_name"),
        paidOn,
        amount,
        method: choice(get, "method", METHOD, "payment method", "cash"),
        referenceNo: optText(get, "reference_no", 60),
        account: acct ? col("account", () => parseChoice(acct, ACCOUNT, "account")) : null,
        notes: optText(get, "notes", 300),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
export type EmployeeRow = {
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  hireDate: IsoDate;
  separationDate: IsoDate | null;
  basis: "monthly" | "daily";
  rate: Centavos;
  allowance: Centavos;
  allowanceTaxable: boolean;
  tin: string;
  sssNo: string;
  philhealthNo: string;
  pagibigNo: string;
  bankAccount: string;
  status: "active" | "inactive";
};

export function validateEmployeeRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>, ctx: RowContext): Validated<EmployeeRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get) => {
      const employeeNo = required(get, "employee_no");
      if (employeeNo.length > 20) throw new FieldError("employee_no is too long (max 20 characters)");
      const rate = reqPeso(get, "rate");
      if (rate <= ZERO) throw new FieldError("rate must be more than ₱0.00");
      const allowance = optPeso(get, "allowance") ?? ZERO;
      if (allowance < ZERO) throw new FieldError("allowance can't be negative");
      const hireDate = reqDate(get, "hire_date", ctx);
      const separationDate = optDate(get, "separation_date", ctx);
      if (separationDate && separationDate < hireDate) throw new FieldError("separation_date is before hire_date");
      return {
        employeeNo,
        ...personName(get),
        position: optText(get, "position", 80),
        hireDate,
        separationDate,
        basis: choice(get, "basis", BASIS, "salary basis", "monthly"),
        rate,
        allowance,
        allowanceTaxable: col("allowance_taxable", () => parseYesNo(get("allowance_taxable"))),
        tin: optText(get, "tin", 20),
        sssNo: optText(get, "sss_no", 20),
        philhealthNo: optText(get, "philhealth_no", 20),
        pagibigNo: optText(get, "pagibig_no", 20),
        bankAccount: optText(get, "bank_account", 60),
        status: choice(get, "status", EMPLOYEE_STATUS, "employee status", separationDate ? "inactive" : "active"),
      };
    }),
  );
  flagDuplicates(out, (d) => d.employeeNo.toUpperCase(), (l) => `Same employee number as line ${l}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Investors
// ---------------------------------------------------------------------------
export type InvestorRow = {
  name: string;
  phone: string;
  email: string | null;
  notes: string;
  plates: { plateNo: string; plateKey: string }[];
};

export function investorKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function validateInvestorRows(rows: readonly RawRow[], cols: ReadonlyMap<string, string>): Validated<InvestorRow>[] {
  const out = rows.map((r) =>
    run(r, cols, (get) => {
      const name = required(get, "name").replace(/\s+/g, " ");
      if (name.length < 2 || name.length > 120) throw new FieldError("name must be 2–120 characters");
      const plates = splitList(get("vehicles")).map((p) => ({ plateNo: cleanPlate(p), plateKey: plateKey(p) }));
      if (new Set(plates.map((p) => p.plateKey)).size !== plates.length) throw new FieldError("vehicles: a plate is listed twice");
      return { name, phone: optText(get, "phone", 20), email: email(get), notes: optText(get, "notes", 500), plates };
    }),
  );
  flagDuplicates(out, (d) => investorKey(d.name), (l) => `Same investor as line ${l}: list all their vehicles on one row.`);
  const plateOwner = new Map<string, number>();
  for (const r of out) {
    if (!r.data) continue;
    for (const p of r.data.plates) {
      const first = plateOwner.get(p.plateKey);
      if (first !== undefined) {
        r.error = `Vehicle ${p.plateNo} is also listed on line ${first}.`;
        delete r.data;
        break;
      }
      plateOwner.set(p.plateKey, r.line);
    }
  }
  return out;
}

/**
 * What can be imported from the old spreadsheets, in the order it must be
 * imported (later kinds look up records created by earlier ones). The column
 * lists drive header matching, the templates in public/templates/ and the
 * help text on the import screen. Keep `import_batches_kind` (SQL) in sync.
 */
export const IMPORT_KINDS = [
  "vehicles",
  "drivers",
  "boundary_plans",
  "rto_contracts",
  "opening_balances",
  "legacy_payments",
  "employees",
  "investors",
  "leads",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export function isImportKind(s: string): s is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(s);
}

export type ColumnSpec = {
  /** Canonical (normalised) header, as written in the template. */
  key: string;
  /** Other normalised headers accepted for this column. */
  aliases?: readonly string[];
  required?: boolean;
  hint: string;
};

export type KindInfo = {
  label: string;
  /** One line for the step list. */
  summary: string;
  /** What the import does, shown above the upload form. */
  details: string[];
  columns: readonly ColumnSpec[];
  /** A date asked on the upload form (see ImportDateParam). */
  dateParam?: "asOf" | "startDate";
};

const MOBILE: ColumnSpec = {
  key: "mobile",
  aliases: ["mobile_number", "mobile_no", "phone", "phone_number", "contact", "contact_no", "contact_number", "cellphone", "cp_no", "cp_number", "driver_mobile"],
  required: true,
  hint: "The driver's mobile number (how the driver is found), e.g. 0917 123 4567.",
};
const DRIVER_NAME: ColumnSpec = {
  key: "driver_name",
  aliases: ["driver", "name", "full_name"],
  hint: "Optional cross-check: a warning is shown if it doesn't match the driver found by mobile.",
};
const PLATE: ColumnSpec = {
  key: "plate_no",
  aliases: ["plate", "plate_number", "plate_num", "plateno", "plate_no_"],
  hint: "Plate number, e.g. NBC 1234.",
};

export const IMPORT_KIND_INFO: Record<ImportKind, KindInfo> = {
  vehicles: {
    label: "Vehicles",
    summary: "The fleet: plate, make, model, type (EV or not), expiries, funding.",
    details: [
      "Creates one vehicle per row. A plate that already exists is skipped (not changed).",
      "Vehicles are assigned to drivers by the boundary plans import, and linked to investors by the investors import.",
    ],
    columns: [
      { ...PLATE, required: true },
      { key: "make", aliases: ["brand"], required: true, hint: "e.g. Toyota, BYD." },
      { key: "model", required: true, hint: "e.g. Vios, e6." },
      { key: "year", aliases: ["model_year", "year_model"], hint: "e.g. 2022." },
      { key: "color", aliases: ["colour"], hint: "" },
      { key: "powertrain", aliases: ["type", "fuel", "fuel_type", "engine"], hint: "ev, ice (gas/diesel) or hybrid. Default ice." },
      { key: "region", hint: "Where the unit operates." },
      { key: "conduction_sticker", aliases: ["cs_no", "conduction"], hint: "" },
      { key: "orcr_expires_on", aliases: ["orcr_expiry", "or_cr_expiry", "registration_expiry", "orcr_expiration"], hint: "OR/CR (registration) expiry date." },
      { key: "insurance_expires_on", aliases: ["insurance_expiry", "insurance_expiration"], hint: "Insurance expiry date." },
      { key: "platforms", aliases: ["platform"], hint: "e.g. inDrive (separate several with ;)." },
      { key: "acquisition_cost", aliases: ["cost", "purchase_price", "acquisition_price"], hint: "Purchase price in pesos." },
      { key: "acquired_on", aliases: ["date_acquired", "purchase_date", "acquisition_date"], hint: "" },
      { key: "funding_source", aliases: ["funding", "funded_by"], hint: "company, investor or financed. Default company." },
      { key: "status", hint: "available, maintenance or retired. Default available." },
      { key: "notes", aliases: ["remarks"], hint: "" },
    ],
  },
  drivers: {
    label: "Drivers",
    summary: "Driver profiles: name, mobile, licence, emergency contact, status.",
    details: [
      "Creates one driver per row. A mobile number that already belongs to a driver is skipped (not changed).",
      "Drivers are imported as active unless the status column says otherwise. Only active drivers are charged boundary.",
    ],
    columns: [
      { key: "first_name", aliases: ["firstname", "given_name"], hint: "First name (or use a single name column)." },
      { key: "last_name", aliases: ["lastname", "surname", "family_name"], hint: "Last name." },
      { key: "name", aliases: ["full_name", "driver_name", "driver"], hint: "Full name, used when first/last name are not given." },
      { ...MOBILE, hint: "PH mobile number, e.g. 0917 123 4567. Must be unique per driver." },
      { key: "email", aliases: ["email_address"], hint: "" },
      { key: "address", hint: "" },
      { key: "birthdate", aliases: ["birthday", "date_of_birth", "dob", "birth_date"], hint: "" },
      { key: "license_no", aliases: ["license", "license_number", "drivers_license", "dl_no"], hint: "Driver's licence number." },
      { key: "license_expiry", aliases: ["license_expiration", "license_expires_on", "dl_expiry"], hint: "" },
      { key: "emergency_contact_name", aliases: ["emergency_contact", "contact_person"], hint: "" },
      { key: "emergency_contact_phone", aliases: ["emergency_phone", "emergency_contact_number", "emergency_number"], hint: "" },
      { key: "status", hint: "active, suspended, applicant, completed or terminated. Default active." },
      { key: "language", aliases: ["sms_language", "preferred_language"], hint: "Reminder language: taglish (default) or en." },
      { key: "notes", aliases: ["remarks"], hint: "" },
    ],
  },
  boundary_plans: {
    label: "Boundary plans",
    summary: "Each driver's daily boundary from go-live, and the vehicle they drive.",
    details: [
      "Starts a boundary plan per driver and assigns the vehicle, from the start date on.",
      "Plans cannot start in the past: the history before go-live goes in the opening balances, never as back-dated daily charges.",
      "A driver who already has a plan is skipped. If today's charges already ran, use Collections → Charges → Run charges now after importing plans that start today.",
    ],
    dateParam: "startDate",
    columns: [
      MOBILE,
      DRIVER_NAME,
      { ...PLATE, hint: "Vehicle the driver uses (optional). It must be free." },
      { key: "program", aliases: ["program_type", "plan", "type"], hint: "boundary or rto (boundary-hulog / rent-to-own). Default boundary." },
      { key: "daily_rate", aliases: ["daily_boundary", "boundary", "rate", "daily"], required: true, hint: "Daily boundary in pesos, e.g. 700." },
      { key: "start_date", aliases: ["effective_from", "start", "starts_on"], hint: "First chargeable day (today or later). Blank = the date chosen below." },
      { key: "notes", aliases: ["remarks"], hint: "" },
    ],
  },
  rto_contracts: {
    label: "RTO contracts",
    summary: "Rent-to-own / boundary-hulog contracts, with what was paid before go-live.",
    details: [
      "Creates the contract and the driver's Amortization account. Installments due up to today are posted at once (with their original due dates).",
      "\"Paid to date\" is everything the driver paid toward the vehicle before go-live (including the down payment if paid). It is posted as one opening credit, so the balance is what is still unpaid.",
      "Do not also put amortization balances of these drivers in the opening balances file.",
      "A driver who already has this contract (same vehicle, active) is skipped.",
    ],
    columns: [
      MOBILE,
      DRIVER_NAME,
      { ...PLATE, required: true, hint: "The vehicle being bought." },
      { key: "contract_price", aliases: ["price", "total_price", "vehicle_price"], required: true, hint: "Total contract price in pesos." },
      { key: "down_payment", aliases: ["dp", "downpayment"], hint: "Default 0." },
      { key: "term_months", aliases: ["term", "months"], hint: "Default 60 (setting rto.default_term_months)." },
      { key: "start_date", aliases: ["contract_date", "signed_on", "date_signed"], required: true, hint: "Signing date (the down payment is due that day). Can be before go-live." },
      { key: "first_due_date", aliases: ["first_due", "first_amortization", "first_payment_date"], required: true, hint: "Due date of installment #1; later ones fall on the same day of each month." },
      { key: "paid_to_date", aliases: ["paid", "total_paid", "amount_paid", "paid_before_go_live"], hint: "Total paid toward the vehicle before go-live. Default 0." },
      { key: "contract_no", aliases: ["old_contract_no", "reference"], hint: "The old contract number (kept in the notes)." },
      { key: "notes", aliases: ["remarks"], hint: "" },
    ],
  },
  opening_balances: {
    label: "Opening balances",
    summary: "What each driver owes (or has in advance) per account at go-live.",
    details: [
      "Posts one 'opening balance' ledger entry per row, dated the as-of date below. Positive = the driver owes; negative = the driver has a credit (advance).",
      "Accounts: boundary, charges (costs & deposit) or amortization (RTO; the driver needs a contract, and usually the contracts import already covers it).",
      "Several rows for the same account are allowed (for example arrears by month, with due dates, to keep the aging). An account that already has an opening balance is refused: reverse it first on the driver page.",
      "Each entry is tagged (type 'opening balance', key import:batch:line) so reports can include or exclude it, and it can never be posted twice.",
    ],
    dateParam: "asOf",
    columns: [
      MOBILE,
      DRIVER_NAME,
      { key: "account", aliases: ["account_type", "type"], required: true, hint: "boundary, charges or amortization." },
      { key: "amount", aliases: ["balance", "amount_owed"], required: true, hint: "Pesos. Positive = owes, negative = credit, e.g. 2,100.00 or -500." },
      { key: "due_date", aliases: ["due", "oldest_due", "since"], hint: "When it fell due (for aging). Blank = the as-of date." },
      { key: "contract_no", hint: "Amortization only, when the driver has more than one contract (e.g. RTO-00012)." },
      { key: "notes", aliases: ["remarks", "reason", "description"], hint: "Kept with the entry." },
    ],
  },
  legacy_payments: {
    label: "Payments before go-live",
    summary: "Old payment history, for reference only (does not change balances).",
    details: [
      "Stored for reference and shown on the driver page under \"Payments before go-live\".",
      "They do NOT change any balance: the opening balance already reflects everything paid before go-live. Receipts (AR numbers) are not issued for them.",
    ],
    dateParam: "asOf",
    columns: [
      MOBILE,
      DRIVER_NAME,
      { key: "paid_on", aliases: ["date", "payment_date", "date_paid"], required: true, hint: "Date paid (on or before the as-of date)." },
      { key: "amount", required: true, hint: "Pesos, e.g. 700." },
      { key: "method", aliases: ["payment_method", "mode"], hint: "cash, gcash, maya, bank or other. Default cash." },
      { key: "reference_no", aliases: ["reference", "ref", "ref_no", "or_no", "receipt_no"], hint: "" },
      { key: "account", aliases: ["for", "applied_to", "type"], hint: "What it paid for: boundary, amortization or charges (optional)." },
      { key: "notes", aliases: ["remarks"], hint: "" },
    ],
  },
  employees: {
    label: "Employees",
    summary: "Office staff for payroll: rate, basis, government numbers.",
    details: ["Creates one employee per row. An employee number that already exists is skipped (not changed)."],
    columns: [
      { key: "employee_no", aliases: ["emp_no", "employee_id", "id_no"], required: true, hint: "Unique employee number." },
      { key: "first_name", aliases: ["firstname"], hint: "" },
      { key: "last_name", aliases: ["lastname", "surname"], hint: "" },
      { key: "name", aliases: ["full_name", "employee_name"], hint: "Full name, used when first/last name are not given." },
      { key: "position", aliases: ["title", "job_title"], hint: "" },
      { key: "hire_date", aliases: ["date_hired", "start_date"], required: true, hint: "" },
      { key: "basis", aliases: ["salary_basis", "pay_basis"], hint: "monthly or daily. Default monthly." },
      { key: "rate", aliases: ["salary", "monthly_salary", "daily_rate", "basic_salary"], required: true, hint: "Monthly salary (monthly basis) or daily rate (daily basis)." },
      { key: "allowance", aliases: ["allowances"], hint: "Per cut-off. Default 0." },
      { key: "allowance_taxable", hint: "yes/no. Default no." },
      { key: "tin", hint: "" },
      { key: "sss_no", aliases: ["sss"], hint: "" },
      { key: "philhealth_no", aliases: ["philhealth"], hint: "" },
      { key: "pagibig_no", aliases: ["pagibig", "hdmf", "hdmf_no"], hint: "" },
      { key: "bank_account", aliases: ["bank_account_no", "account_no"], hint: "" },
      { key: "status", hint: "active or inactive. Default active." },
      { key: "separation_date", aliases: ["date_separated", "end_date"], hint: "" },
    ],
  },
  investors: {
    label: "Investors",
    summary: "Investors and the vehicles they funded.",
    details: [
      "Creates each investor (an investor with the same name is reused) and links the listed vehicles to them (funding source: investor).",
      "A vehicle already linked to another investor is refused.",
    ],
    columns: [
      { key: "name", aliases: ["investor", "investor_name", "full_name"], required: true, hint: "" },
      { key: "phone", aliases: ["mobile", "contact", "contact_no"], hint: "" },
      { key: "email", hint: "" },
      { key: "vehicles", aliases: ["plates", "plate_nos", "units", "plate_no"], hint: "Plate numbers of their vehicles, separated by ;" },
      { key: "notes", aliases: ["remarks"], hint: "" },
    ],
  },
  leads: {
    label: "Leads",
    summary: "Old lead lists (Facebook, Messenger, walk-ins) into the CRM.",
    details: [
      "Uses the CRM lead import: a row whose mobile matches an open lead is added to that lead's timeline instead of creating a duplicate.",
      "Day-to-day lead lists can also be imported from Leads (CRM) → Import.",
    ],
    // Same headers and aliases as validateLeadRows (src/lib/crm.ts), which does the parsing.
    columns: [
      { key: "name", aliases: ["full_name", "fullname"], required: true, hint: "" },
      { key: "mobile", aliases: ["mobile_number", "phone", "phone_number", "contact", "contact_number"], hint: "Mobile, email or Facebook name is required." },
      { key: "email", aliases: ["email_address"], hint: "" },
      { key: "facebook", aliases: ["fb_name", "facebook_name", "messenger"], hint: "Facebook / Messenger name." },
      { key: "source", hint: "Facebook, Messenger, walk-in, referral, website, TikTok or other." },
      { key: "interest", aliases: ["service", "service_interested_in"], hint: "franchise, activation, vehicle_program, fleet, investment, school or other." },
      { key: "location", aliases: ["city", "address"], hint: "" },
      { key: "notes", aliases: ["message", "remarks"], hint: "" },
    ],
  },
};

export type HeaderMatch = {
  /** Canonical key → the header found in the file. */
  columns: Map<string, string>;
  missing: string[];
  ignored: string[];
};

/** Matches a file's (normalised) headers to a kind's columns, using aliases. */
export function matchHeaders(kind: ImportKind, headers: readonly string[]): HeaderMatch {
  const present = new Set(headers.filter(Boolean));
  const used = new Set<string>();
  const columns = new Map<string, string>();
  // Exact canonical names first, so an alias of one column can't steal another column's header.
  for (const c of IMPORT_KIND_INFO[kind].columns) {
    if (present.has(c.key)) {
      columns.set(c.key, c.key);
      used.add(c.key);
    }
  }
  for (const c of IMPORT_KIND_INFO[kind].columns) {
    if (columns.has(c.key)) continue;
    const hit = (c.aliases ?? []).find((a) => present.has(a) && !used.has(a));
    if (hit) {
      columns.set(c.key, hit);
      used.add(hit);
    }
  }
  const missing = IMPORT_KIND_INFO[kind].columns.filter((c) => c.required && !columns.has(c.key)).map((c) => c.key);
  const ignored = [...present].filter((h) => !used.has(h));
  return { columns, missing, ignored };
}

/** Base name of the kind's template in public/templates/ (".csv" and ".xlsx"). */
export function templateName(kind: ImportKind): string {
  return kind.replaceAll("_", "-");
}

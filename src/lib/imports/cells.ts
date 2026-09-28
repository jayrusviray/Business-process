/**
 * Cell parsing for spreadsheet imports (CSV and Excel). Pure functions.
 *
 * Money: Excel stores numbers as binary floating point, so a numeric cell is
 * turned into its shortest decimal text first (excelNumberToString) and only
 * then parsed into integer centavos with the string-based parsePeso. No money
 * is ever computed with `number`.
 */
import { isIsoDate, type IsoDate } from "../dates";
import { MoneyParseError, parsePeso, type Centavos } from "../money";

/** A cell that can't be used; the message is shown in the import preview. */
export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldError";
  }
}

function centsText(cents: bigint): string {
  const neg = cents < BigInt(0);
  const abs = neg ? -cents : cents;
  const h = BigInt(100);
  const frac = (abs % h).toString().padStart(2, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / h}${frac ? `.${frac}` : ""}`;
}

/**
 * An Excel numeric cell as text, without floating-point noise:
 * 700 → "700", 1234.5 → "1234.5", 9171234567 → "9171234567", and a formula
 * result like 0.1 + 0.2 = 0.30000000000000004 → "0.3" (snapped to the centavo
 * when it is within a millionth of one). Anything else keeps all its digits,
 * so money validation rejects it instead of silently rounding.
 */
export function excelNumberToString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
  const s = String(n);
  if (!/e/i.test(s) && (s.split(".")[1] ?? "").length <= 2) return s;
  const scaled = n * 100;
  const cents = Math.round(scaled);
  if (Number.isSafeInteger(cents) && Math.abs(scaled - cents) < 1e-6) return centsText(BigInt(cents));
  return s;
}

const DAY_MS = 86_400_000;

/**
 * Excel serial day number → ISO date. 1900 system (Windows default): serial 1 =
 * 1900-01-01 and Excel's fictitious 1900-02-29 is serial 60, so serials from 61
 * on count from 1899-12-30. 1904 system (old Mac workbooks): serial 0 = 1904-01-01.
 * A time of day (fraction) is ignored. Returns null outside 1900–2200.
 */
export function excelSerialToIso(serial: number, date1904 = false): IsoDate | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const whole = Math.floor(serial);
  let ms: number;
  if (date1904) ms = Date.UTC(1904, 0, 1) + whole * DAY_MS;
  else if (whole >= 61) ms = Date.UTC(1899, 11, 30) + whole * DAY_MS;
  else if (whole === 60) return null; // 1900-02-29 does not exist
  else ms = Date.UTC(1899, 11, 31) + whole * DAY_MS;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2200) return null;
  return ymd(y, d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Calendar date of a date cell read by exceljs. It builds Date objects at UTC
 * midnight of the sheet's wall-clock date (plus any time of day), so the UTC
 * components ARE the calendar date. (Not a "now" conversion: no time zone applies.)
 */
export function sheetDateToIso(d: Date): IsoDate {
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function ymd(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function fullYear(y: string): number {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return n <= 69 ? 2000 + n : 1900 + n; // POSIX pivot: 00–69 → 20xx, 70–99 → 19xx
}

function checked(y: number, m: number, d: number, input: string): IsoDate {
  const iso = ymd(y, m, d);
  if (!isIsoDate(iso) || y < 1900 || y > 2200) throw new FieldError(`"${input}" is not a valid date`);
  return iso;
}

/**
 * Dates as people type them in PH spreadsheets:
 *   2026-09-27, 2026/09/27, 20260927 · 9/27/2026, 09-27-26 (month first, the PH/US
 *   default; day first only when the first number is over 12, e.g. 27/09/2026) ·
 *   Sep 27, 2026 · 27 Sep 2026 · 27-Sep-26 · Excel serial numbers (46292).
 */
export function parseImportDate(input: string, opts: { date1904?: boolean } = {}): IsoDate {
  const s = input.trim().replace(/\s+/g, " ");
  if (!s) throw new FieldError("is empty");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return checked(+m[1], +m[2], +m[3], input);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return checked(+m[1], +m[2], +m[3], input);
  m = /^(\d{5,6})(?:\.\d+)?$/.exec(s);
  if (m) {
    const iso = excelSerialToIso(Number(s), opts.date1904);
    if (!iso) throw new FieldError(`"${input}" is not a valid date`);
    return iso;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: .*)?$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const [month, day] = a > 12 && b <= 12 ? [b, a] : [a, b];
    return checked(fullYear(m[3]), month, day, input);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[ /-]([A-Za-z]{3,9})\.?,?[ /-](\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return checked(fullYear(m[3]), MONTHS[m[2].toLowerCase()], +m[1], input);
  m = /^([A-Za-z]{3,9})\.?[ /-](\d{1,2})(?:st|nd|rd|th)?,?[ /-](\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return checked(fullYear(m[3]), MONTHS[m[1].toLowerCase()], +m[2], input);
  throw new FieldError(`"${input}" is not a date (use YYYY-MM-DD or MM/DD/YYYY)`);
}

/**
 * Peso amounts as found in sheets: "1,250.50", "₱ 700", "P700", "PHP 1,000.00",
 * "-500", "(500.00)" (accounting negative). At most two decimals.
 */
export function parseImportPeso(input: string): Centavos {
  const bad = () => new FieldError(`"${input.trim()}" is not a peso amount (at most 2 decimals, e.g. 1,250.50)`);
  let s = input.trim();
  if (!s) throw new FieldError("is empty");
  let signs = 0;
  if (/^\(.*\)$/.test(s)) {
    signs++;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    signs++;
    s = s.slice(1).trim();
  }
  s = s.replace(/^(₱|php|p)\.?\s*/i, "");
  if (s.startsWith("-")) {
    signs++;
    s = s.slice(1).trim();
  }
  if (signs > 1) throw bad();
  let v: Centavos;
  try {
    v = parsePeso(s);
  } catch (e) {
    if (e instanceof MoneyParseError) throw bad();
    throw e;
  }
  if (v < BigInt(0)) throw bad();
  return signs ? -v : v;
}

/** Whole numbers such as a year or a term in months ("60", "60.0"). */
export function parseImportInt(input: string, min: number, max: number): number {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d+(\.0+)?$/.test(s)) throw new FieldError(`"${input.trim()}" is not a whole number`);
  const n = Number.parseInt(s, 10);
  if (n < min || n > max) throw new FieldError(`must be between ${min} and ${max}`);
  return n;
}

const YES = new Set(["y", "yes", "true", "1", "oo", "x", "✓"]);
const NO = new Set(["n", "no", "false", "0", "hindi", ""]);

export function parseYesNo(input: string): boolean {
  const s = input.trim().toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  throw new FieldError(`"${input.trim()}" is not yes/no`);
}

/**
 * One of a fixed set of values, matched case-insensitively with aliases.
 * Keys of `aliases` are compared after lowercasing and turning spaces, dashes
 * and underscores into single spaces.
 */
export function parseChoice<T extends string>(input: string, aliases: Record<string, T>, what: string): T {
  const k = input.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const hit = aliases[k];
  if (hit) return hit;
  const allowed = [...new Set(Object.values(aliases))].join(", ");
  throw new FieldError(`"${input.trim()}" is not a valid ${what} (use ${allowed})`);
}

/** Plate as stored: uppercase, single spaces ("abc  1234" → "ABC 1234"). */
export function cleanPlate(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Plate for matching: letters and digits only ("ABC-1234" = "abc 1234"). */
export function plateKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "A; B, C" → ["A", "B", "C"]. */
export function splitList(input: string): string[] {
  return input
    .split(/[;,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Loose name comparison for cross-checks ("Dela Cruz, Juan" ~ "juan dela cruz"). */
export function nameTokens(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

/** True when every token of the shorter name appears in the other. */
export function namesMatch(a: string, b: string): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.size === 0 || y.size === 0) return true;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((t) => big.has(t));
}

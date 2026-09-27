/**
 * Money primitives. ALL amounts are integer centavos held as `bigint`.
 * Never use `number` for money arithmetic and never parse money with parseFloat.
 * Postgres `bigint` columns map to this type (Drizzle `mode: "bigint"`).
 */
export type Centavos = bigint;

export const ZERO: Centavos = BigInt(0);
const HUNDRED = BigInt(100);
const BPS_DENOM = BigInt(10_000);

/** Build centavos from a whole-peso integer literal, e.g. `pesos(1500)` = ₱1,500.00. For code/tests only. */
export function pesos(whole: number): Centavos {
  if (!Number.isSafeInteger(whole)) throw new RangeError(`pesos() expects a safe integer, got ${whole}`);
  return BigInt(whole) * HUNDRED;
}

const PESO_INPUT = /^(-)?\s*₱?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/;

/**
 * Parse user input ("1,250.50", "₱ 700", "-15.5") into centavos.
 * Rejects more than 2 decimal places, stray characters, and empty input.
 */
export function parsePeso(input: string): Centavos {
  const s = input.trim();
  const m = PESO_INPUT.exec(s);
  if (!m || (m[2] === undefined && m[3] === undefined)) {
    throw new MoneyParseError(input);
  }
  const whole = BigInt((m[2] ?? "0").replaceAll(",", ""));
  const frac = BigInt((m[3] ?? "0").padEnd(2, "0"));
  const value = whole * HUNDRED + frac;
  return m[1] ? -value : value;
}

export class MoneyParseError extends Error {
  constructor(input: string) {
    super(`Invalid peso amount: "${input}"`);
    this.name = "MoneyParseError";
  }
}

/** Format centavos as "₱1,234.56" (negative: "-₱1,234.56"). */
export function formatPeso(amount: Centavos, opts: { symbol?: boolean } = {}): string {
  const symbol = opts.symbol ?? true;
  const neg = amount < ZERO;
  const abs = neg ? -amount : amount;
  const whole = (abs / HUNDRED).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % HUNDRED).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${symbol ? "₱" : ""}${whole}.${frac}`;
}

/** Plain decimal string for inputs/exports, e.g. "1234.56". */
export function toDecimalString(amount: Centavos): string {
  const neg = amount < ZERO;
  const abs = neg ? -amount : amount;
  return `${neg ? "-" : ""}${abs / HUNDRED}.${(abs % HUNDRED).toString().padStart(2, "0")}`;
}

export function sum(values: Iterable<Centavos>): Centavos {
  let total = ZERO;
  for (const v of values) total += v;
  return total;
}

export type Rounding = "half_up" | "down" | "up";

/**
 * Integer division with explicit rounding. `half_up` rounds .5 away from zero,
 * which is how PH payroll/government tables round centavos.
 */
export function divRound(numerator: bigint, denominator: bigint, rounding: Rounding = "half_up"): bigint {
  if (denominator === ZERO) throw new RangeError("division by zero");
  if (denominator < ZERO) return divRound(-numerator, -denominator, rounding);
  const neg = numerator < ZERO;
  const n = neg ? -numerator : numerator;
  let q = n / denominator;
  const r = n % denominator;
  if (r !== ZERO) {
    if (rounding === "up") q += BigInt(1);
    else if (rounding === "half_up" && r * BigInt(2) >= denominator) q += BigInt(1);
  }
  return neg ? -q : q;
}

/** amount × rate, where rate is in basis points (1% = 100 bps). */
export function applyBps(amount: Centavos, bps: number | bigint, rounding: Rounding = "half_up"): Centavos {
  return divRound(amount * BigInt(bps), BPS_DENOM, rounding);
}

/**
 * Split `amount` across `weights` so the parts always sum exactly to `amount`
 * (largest-remainder method; ties go to the earliest index).
 */
export function allocateByWeights(amount: Centavos, weights: readonly bigint[]): Centavos[] {
  if (weights.length === 0) throw new RangeError("weights must not be empty");
  if (weights.some((w) => w < ZERO)) throw new RangeError("weights must be non-negative");
  const total = sum(weights);
  if (total === ZERO) throw new RangeError("weights must not all be zero");
  const neg = amount < ZERO;
  const abs = neg ? -amount : amount;
  const parts = weights.map((w) => (abs * w) / total);
  let remainder = abs - sum(parts);
  const order = weights
    .map((w, i) => ({ i, rem: (abs * w) % total }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; remainder > ZERO; k = (k + 1) % order.length) {
    parts[order[k].i] += BigInt(1);
    remainder -= BigInt(1);
  }
  return neg ? parts.map((p) => -p) : parts;
}

export function maxC(a: Centavos, b: Centavos): Centavos {
  return a > b ? a : b;
}

export function minC(a: Centavos, b: Centavos): Centavos {
  return a < b ? a : b;
}

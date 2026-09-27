import { describe, expect, it } from "vitest";
import {
  allocateByWeights,
  applyBps,
  divRound,
  formatPeso,
  MoneyParseError,
  parsePeso,
  pesos,
  sum,
  toDecimalString,
} from "./money";

const c = (n: number) => BigInt(n);

describe("parsePeso", () => {
  it.each([
    ["0", 0],
    ["700", 70000],
    ["1,250.50", 125050],
    ["₱ 1,234,567.8", 123456780],
    ["₱700", 70000],
    [".5", 50],
    ["15.05", 1505],
    ["-15.5", -1550],
    ["  42.00 ", 4200],
  ])("parses %s", (input, expected) => {
    expect(parsePeso(input)).toBe(c(expected));
  });

  it.each(["", " ", "abc", "1.234", "1,23", "12,34.00", "1e3", "₱", "--1", "1.2.3", "NaN", "0x10"])(
    "rejects %j",
    (input) => {
      expect(() => parsePeso(input)).toThrow(MoneyParseError);
    },
  );

  it("never goes through floating point (0.1 + 0.2 case)", () => {
    expect(parsePeso("0.1") + parsePeso("0.2")).toBe(parsePeso("0.3"));
  });
});

describe("formatPeso", () => {
  it.each([
    [0, "₱0.00"],
    [5, "₱0.05"],
    [70000, "₱700.00"],
    [123456789, "₱1,234,567.89"],
    [-1550, "-₱15.50"],
  ])("formats %d", (input, expected) => {
    expect(formatPeso(c(input))).toBe(expected);
  });

  it("round-trips with parsePeso", () => {
    for (const v of [0, 1, 99, 100, 101, 999999, 123456789, -42]) {
      expect(parsePeso(formatPeso(c(v)))).toBe(c(v));
    }
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatPeso(BigInt("900719925474099312"))).toBe("₱9,007,199,254,740,993.12");
  });

  it("can omit the symbol / produce plain decimals", () => {
    expect(formatPeso(c(123456), { symbol: false })).toBe("1,234.56");
    expect(toDecimalString(c(-5))).toBe("-0.05");
  });
});

describe("arithmetic", () => {
  it("pesos() builds whole-peso amounts", () => {
    expect(pesos(1500)).toBe(c(150000));
    expect(() => pesos(1.5)).toThrow();
  });

  it("sum", () => {
    expect(sum([c(1), c(2), c(-3)])).toBe(c(0));
    expect(sum([])).toBe(c(0));
  });

  it("divRound rounds half away from zero by default", () => {
    expect(divRound(c(5), c(2))).toBe(c(3));
    expect(divRound(c(-5), c(2))).toBe(c(-3));
    expect(divRound(c(4), c(3))).toBe(c(1));
    expect(divRound(c(5), c(2), "down")).toBe(c(2));
    expect(divRound(c(4), c(3), "up")).toBe(c(2));
    expect(divRound(c(6), c(-4))).toBe(c(-2));
    expect(() => divRound(c(1), c(0))).toThrow();
  });

  it("applyBps", () => {
    expect(applyBps(pesos(20000), 500)).toBe(pesos(1000)); // 5%
    expect(applyBps(c(333), 5000)).toBe(c(167)); // 166.5 → 167
    expect(applyBps(c(333), 5000, "down")).toBe(c(166));
  });
});

describe("allocateByWeights", () => {
  it("always sums exactly to the amount", () => {
    const parts = allocateByWeights(c(100), [c(1), c(1), c(1)]);
    expect(parts).toEqual([c(34), c(33), c(33)]);
    expect(sum(parts)).toBe(c(100));
  });

  it("is proportional", () => {
    expect(allocateByWeights(pesos(1000), [c(3), c(1)])).toEqual([pesos(750), pesos(250)]);
  });

  it("gives leftovers to the largest remainders", () => {
    expect(allocateByWeights(c(10), [c(1), c(2)])).toEqual([c(3), c(7)]);
  });

  it("handles negatives and zero weights", () => {
    expect(allocateByWeights(c(-100), [c(1), c(0), c(1)])).toEqual([c(-50), c(0), c(-50)]);
  });

  it("rejects bad weights", () => {
    expect(() => allocateByWeights(c(1), [])).toThrow();
    expect(() => allocateByWeights(c(1), [c(0)])).toThrow();
    expect(() => allocateByWeights(c(1), [c(-1), c(2)])).toThrow();
  });

  it("property: exact sum for many random cases", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 500; i++) {
      const amount = BigInt(rand() % 10_000_000) - BigInt(1_000_000);
      const weights = Array.from({ length: 1 + (rand() % 6) }, () => BigInt(rand() % 1000));
      if (sum(weights) === BigInt(0)) continue;
      expect(sum(allocateByWeights(amount, weights))).toBe(amount);
    }
  });
});

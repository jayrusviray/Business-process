import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  businessToday,
  dayOfWeek,
  daysBetween,
  eachDay,
  endOfMonth,
  formatBusinessDate,
  isIsoDate,
  isoDate,
  monthsElapsed,
  startOfMonth,
  toBusinessDate,
} from "./dates";

const d = isoDate;

describe("business date in Manila", () => {
  it("uses Manila, not UTC, around midnight", () => {
    // 2026-09-26T16:30Z = 2026-09-27 00:30 PHT
    expect(toBusinessDate(new Date("2026-09-26T16:30:00Z"))).toBe("2026-09-27");
    // 2026-09-27T15:59Z = 23:59 PHT same day
    expect(toBusinessDate(new Date("2026-09-27T15:59:59Z"))).toBe("2026-09-27");
    expect(toBusinessDate(new Date("2026-09-27T16:00:00Z"))).toBe("2026-09-28");
  });

  it("businessToday accepts an injected clock", () => {
    expect(businessToday(new Date("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
  });
});

describe("validation", () => {
  it.each(["2026-02-29", "2026-13-01", "2026-1-01", "20260101", "2026-04-31", ""])("rejects %j", (s) => {
    expect(isIsoDate(s)).toBe(false);
  });
  it("accepts leap day", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(() => isoDate("nope")).toThrow();
  });
});

describe("arithmetic", () => {
  it("addDays crosses months and years", () => {
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2028-03-01"), -1)).toBe("2028-02-29");
  });

  it("daysBetween / eachDay", () => {
    expect(daysBetween(d("2026-01-01"), d("2026-03-01"))).toBe(59);
    expect(eachDay(d("2026-02-27"), d("2026-03-02"))).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(eachDay(d("2026-03-02"), d("2026-03-01"))).toEqual([]);
  });

  it("dayOfWeek", () => {
    expect(dayOfWeek(d("2026-09-27"))).toBe(0); // Sunday
  });

  it("addMonths clamps to month end", () => {
    expect(addMonths(d("2026-01-31"), 1)).toBe("2026-02-28");
    expect(addMonths(d("2028-01-31"), 1)).toBe("2028-02-29");
    expect(addMonths(d("2026-11-15"), 3)).toBe("2027-02-15");
    expect(addMonths(d("2026-03-31"), -1)).toBe("2026-02-28");
  });

  it("addMonths with anchorDay does not drift after clamping", () => {
    const feb = addMonths(d("2026-01-31"), 1, 31);
    expect(feb).toBe("2026-02-28");
    expect(addMonths(feb, 1, 31)).toBe("2026-03-31");
  });

  it("monthsElapsed counts full calendar months", () => {
    expect(monthsElapsed(d("2026-01-15"), d("2026-04-14"))).toBe(2);
    expect(monthsElapsed(d("2026-01-15"), d("2026-04-15"))).toBe(3);
    expect(monthsElapsed(d("2026-01-31"), d("2026-02-28"))).toBe(1);
    expect(monthsElapsed(d("2026-01-31"), d("2026-02-27"))).toBe(0);
    expect(monthsElapsed(d("2026-04-15"), d("2026-01-15"))).toBe(-3);
  });

  it("month boundaries", () => {
    expect(startOfMonth(d("2026-09-27"))).toBe("2026-09-01");
    expect(endOfMonth(d("2028-02-10"))).toBe("2028-02-29");
  });

  it("formats for display", () => {
    expect(formatBusinessDate(d("2026-09-27"))).toMatch(/Sep 27, 2026/);
  });
});

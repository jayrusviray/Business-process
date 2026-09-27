import { describe, expect, it } from "vitest";
import { isoDate } from "./dates";
import { isHit, periodFor, progressPercent } from "./quotas";

describe("quota periods", () => {
  it("monthly", () => {
    expect(periodFor("monthly", isoDate("2026-02-14"))).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
  it("weekly runs Monday to Sunday", () => {
    expect(periodFor("weekly", isoDate("2026-09-27"))).toEqual({ start: "2026-09-21", end: "2026-09-27" }); // Sunday
    expect(periodFor("weekly", isoDate("2026-09-28"))).toEqual({ start: "2026-09-28", end: "2026-10-04" }); // Monday
  });
});

describe("hits and progress", () => {
  it("200 rides is a hit, 199 is not", () => {
    expect(isHit(BigInt(200), BigInt(200))).toBe(true);
    expect(isHit(BigInt(199), BigInt(200))).toBe(false);
  });
  it("progress is capped and floored", () => {
    expect(progressPercent(BigInt(150), BigInt(200))).toBe(75);
    expect(progressPercent(BigInt(250), BigInt(200))).toBe(100);
    expect(progressPercent(BigInt(1), BigInt(0))).toBe(0);
  });
});

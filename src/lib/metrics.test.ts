import { describe, expect, it } from "vitest";
import { isoDate } from "./dates";
import {
  agingBuckets,
  bucketEnd,
  bucketLabel,
  bucketsBetween,
  bucketStart,
  formatBps,
  groupSums,
  installmentsLeft,
  periodRange,
  projectedCompletion,
  ratioBps,
  startOfWeek,
} from "./metrics";
import { pesos, ZERO } from "./money";

const D = isoDate;

describe("agingBuckets", () => {
  const asOf = D("2026-09-30");
  it("puts each outstanding amount in 1–7, 8–15, 16–30 or over 30 days (spec)", () => {
    const a = agingBuckets(
      [
        { dueDate: D("2026-09-30"), outstanding: pesos(700) }, // due today → current
        { dueDate: D("2026-10-05"), outstanding: pesos(1) }, // future → current
        { dueDate: D("2026-09-29"), outstanding: pesos(700) }, // 1 day
        { dueDate: D("2026-09-23"), outstanding: pesos(700) }, // 7 days
        { dueDate: D("2026-09-22"), outstanding: pesos(700) }, // 8 days
        { dueDate: D("2026-09-15"), outstanding: pesos(300) }, // 15 days
        { dueDate: D("2026-09-14"), outstanding: pesos(200) }, // 16 days
        { dueDate: D("2026-08-31"), outstanding: pesos(100) }, // 30 days
        { dueDate: D("2026-08-30"), outstanding: pesos(50) }, // 31 days
        { dueDate: D("2025-01-01"), outstanding: pesos(5) },
        { dueDate: D("2026-09-01"), outstanding: ZERO }, // fully paid: ignored
      ],
      asOf,
    );
    expect(a.current).toBe(pesos(701));
    expect(a.buckets).toEqual([pesos(1_400), pesos(1_000), pesos(300), pesos(55)]);
    expect(a.total).toBe(pesos(3_456));
    expect(a.total).toBe(a.current + a.buckets.reduce((s, v) => s + v, ZERO));
    expect(a.labels).toEqual(["1–7 days", "8–15 days", "16–30 days", "Over 30 days"]);
  });

  it("uses configurable limits", () => {
    const a = agingBuckets([{ dueDate: D("2026-09-20"), outstanding: pesos(10) }], asOf, [5, 10, 20]);
    expect(a.buckets).toEqual([ZERO, pesos(10), ZERO, ZERO]);
    expect(a.labels[3]).toBe("Over 20 days");
  });

  it("partial payments: only the unpaid part is aged", () => {
    const a = agingBuckets([{ dueDate: D("2026-09-28"), outstanding: pesos(200) }], asOf);
    expect(a.buckets[0]).toBe(pesos(200));
  });
});

describe("rates", () => {
  it("ratioBps floors and is null without a base", () => {
    expect(ratioBps(1, 3)).toBe(3333);
    expect(ratioBps(5, 4)).toBe(12500);
    expect(ratioBps(0, 10)).toBe(0);
    expect(ratioBps(3, 0)).toBeNull();
  });
  it("formats basis points", () => {
    expect(formatBps(1234)).toBe("12.3%");
    expect(formatBps(null)).toBe("—");
    expect(formatBps(10000, 0)).toBe("100%");
  });
});

describe("projectedCompletion", () => {
  it("projects the remaining balance at the driver's own pace", () => {
    // Paid 100,000 in 100 days → 1,000/day; 50,000 left → 50 more days.
    expect(projectedCompletion(pesos(100_000), pesos(50_000), D("2026-01-01"), D("2026-04-11"))).toBe("2026-05-31");
  });
  it("rounds partial days up", () => {
    expect(projectedCompletion(pesos(3), pesos(1), D("2026-01-01"), D("2026-01-04"))).toBe("2026-01-05");
  });
  it("is null when nothing was paid, and today when paid off", () => {
    expect(projectedCompletion(ZERO, pesos(1), D("2026-01-01"), D("2026-02-01"))).toBeNull();
    expect(projectedCompletion(pesos(9), ZERO, D("2026-01-01"), D("2026-02-01"))).toBe("2026-02-01");
  });
  it("counts at least one day on the start date", () => {
    expect(projectedCompletion(pesos(10), pesos(10), D("2026-03-01"), D("2026-03-01"))).toBe("2026-03-02");
  });
});

describe("installmentsLeft", () => {
  it("rounds up to whole installments", () => {
    expect(installmentsLeft(pesos(30_000), pesos(10_000))).toBe(3);
    expect(installmentsLeft(pesos(30_001), pesos(10_000))).toBe(4);
    expect(installmentsLeft(ZERO, pesos(10_000))).toBe(0);
    expect(installmentsLeft(pesos(-5), pesos(10_000))).toBe(0);
  });
});

describe("periods and buckets", () => {
  const today = D("2026-09-30"); // a Wednesday
  it("period ranges", () => {
    expect(periodRange("day", today)).toEqual({ from: today, to: today });
    expect(periodRange("week", today)).toEqual({ from: "2026-09-28", to: today });
    expect(periodRange("month", today)).toEqual({ from: "2026-09-01", to: today });
    expect(periodRange("custom", today, D("2026-09-10"), D("2026-09-01"))).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(periodRange("custom", today)).toEqual({ from: "2026-09-01", to: today });
  });
  it("weeks start on Monday", () => {
    expect(startOfWeek(D("2026-09-27"))).toBe("2026-09-21"); // Sunday → previous Monday
    expect(startOfWeek(D("2026-09-28"))).toBe("2026-09-28");
  });
  it("bucket starts, labels and ends", () => {
    expect(bucketStart(D("2026-09-30"), "month")).toBe("2026-09-01");
    expect(bucketStart(D("2026-09-30"), "week")).toBe("2026-09-28");
    expect(bucketLabel(D("2026-09-01"), "month")).toBe("2026-09");
    expect(bucketEnd(D("2026-09-28"), "week", D("2026-09-30"))).toBe("2026-09-30");
    expect(bucketEnd(D("2026-02-01"), "month", D("2026-12-31"))).toBe("2026-02-28");
  });
  it("lists every bucket so empty periods still show", () => {
    expect(bucketsBetween(D("2026-01-31"), D("2026-04-02"), "month")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(bucketsBetween(D("2026-09-29"), D("2026-10-01"), "day")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(bucketsBetween(D("2026-09-30"), D("2026-10-12"), "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
  });
});

describe("groupSums", () => {
  it("sums bigint fields exactly per key, in first-seen order", () => {
    const g = groupSums(
      [
        { k: "b", x: BigInt(1), y: BigInt(10) },
        { k: "a", x: BigInt(2), y: BigInt(20) },
        { k: "b", x: BigInt(3), y: BigInt(30) },
      ],
      (r) => r.k,
      ["x", "y"] as const,
      (r, f) => r[f],
    );
    expect([...g.keys()]).toEqual(["b", "a"]);
    expect(g.get("b")).toEqual({ sums: { x: BigInt(4), y: BigInt(40) }, count: 2 });
  });
});

import { describe, expect, it } from "vitest";
import { followupBucket, leadAgeDays, normalizeMobile, parseLeadSource, parseServiceLine, pickAgent, validateLeadRows } from "./crm";
import { isoDate } from "./dates";

describe("normalizeMobile", () => {
  it("normalises PH mobiles in any common format", () => {
    for (const s of ["09171234567", "0917 123 4567", "+63 917 123 4567", "639171234567", "9171234567", "(0917) 123-4567"]) {
      expect(normalizeMobile(s)).toEqual({ mobile: "09171234567", e164: "+639171234567" });
    }
  });
  it("keeps other numbers as typed, without an E.164 form", () => {
    expect(normalizeMobile(" 02 8123 4567 ")).toEqual({ mobile: "02 8123 4567", e164: null });
    expect(normalizeMobile("")).toEqual({ mobile: "", e164: null });
  });
});

describe("follow-ups and age", () => {
  const today = isoDate("2026-10-15");
  it("buckets due dates", () => {
    expect(followupBucket(isoDate("2026-10-14"), today)).toBe("overdue");
    expect(followupBucket(today, today)).toBe("today");
    expect(followupBucket(isoDate("2026-10-22"), today)).toBe("soon");
    expect(followupBucket(isoDate("2026-10-23"), today)).toBe("later");
  });
  it("counts lead age in days, never negative", () => {
    expect(leadAgeDays(isoDate("2026-10-01"), today)).toBe(14);
    expect(leadAgeDays(isoDate("2026-10-20"), today)).toBe(0);
  });
});

describe("pickAgent", () => {
  it("prefers the fewest open leads, then the least recently assigned, then id", () => {
    expect(pickAgent([])).toBeNull();
    expect(pickAgent([{ id: "b", openLeads: 3, lastAssignedAt: 1 }, { id: "a", openLeads: 2, lastAssignedAt: 9 }])).toBe("a");
    expect(pickAgent([{ id: "a", openLeads: 2, lastAssignedAt: 9 }, { id: "b", openLeads: 2, lastAssignedAt: 1 }])).toBe("b");
    expect(pickAgent([{ id: "b", openLeads: 0, lastAssignedAt: null }, { id: "a", openLeads: 0, lastAssignedAt: null }])).toBe("a");
  });
});

describe("lead import parsing", () => {
  it("maps sources and interests loosely", () => {
    expect(parseLeadSource("Facebook")).toBe("facebook_page");
    expect(parseLeadSource("walk-in")).toBe("walk_in");
    expect(parseLeadSource("fb_lead_ad")).toBe("fb_lead_ad");
    expect(parseLeadSource("")).toBe("other");
    expect(parseLeadSource("billboard")).toBeNull();
    expect(parseServiceLine("LTFRB CPC renewal")).toBe("franchise");
    expect(parseServiceLine("inDrive activation")).toBe("activation");
    expect(parseServiceLine("rent to own")).toBe("vehicle_program");
    expect(parseServiceLine("vehicle_program")).toBe("vehicle_program");
    expect(parseServiceLine("")).toBe("other");
    expect(parseServiceLine("pizza")).toBeNull();
  });
  it("validates rows and reports the spreadsheet line", () => {
    const rows = validateLeadRows([
      { name: "Juan Dela Cruz", mobile: "0917 123 4567", source: "Messenger", interest: "franchise" },
      { name: "", mobile: "09170000000" },
      { name: "No Contact" },
      { name: "Bad Phone", mobile: "12345" },
      { name: "FB Only", facebook: "Juan DC", source: "billboard" },
      { name: "Mail", email: "not-an-email" },
    ]);
    expect(rows[0]).toMatchObject({ line: 2, mobile: "09171234567", e164: "+639171234567", source: "messenger", interest: "franchise" });
    expect(rows[0].error).toBeUndefined();
    expect(rows.slice(1).map((r) => r.error)).toEqual([
      "Name is required.",
      "Give a mobile number, email or Facebook name.",
      '"12345" is not a PH mobile number.',
      'Unknown source "billboard".',
      '"not-an-email" is not a valid email.',
    ]);
  });
});

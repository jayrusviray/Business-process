import { describe, expect, it } from "vitest";
import { homePathFor, isStaff } from "./roles";
import { navForRoles } from "../nav";

describe("roles", () => {
  it("routes users to their home", () => {
    expect(homePathFor(["finance"])).toBe("/app");
    expect(homePathFor(["driver"])).toBe("/portal");
    expect(homePathFor(["driver", "operations"])).toBe("/app");
    expect(homePathFor([])).toBe("/pending");
  });

  it("isStaff", () => {
    expect(isStaff(["sales"])).toBe(true);
    expect(isStaff(["driver", "investor"])).toBe(false);
  });
});

describe("navigation", () => {
  const keys = (roles: Parameters<typeof navForRoles>[0]) =>
    navForRoles(roles).flatMap((s) => s.items.map((i) => i.href));

  it("sales never sees payroll, investor or settings screens", () => {
    const k = keys(["sales"]);
    expect(k).toContain("/app/m/crm");
    expect(k.some((h) => /payroll|investors|admin/.test(h))).toBe(false);
  });

  it("owner_admin sees everything", () => {
    expect(keys(["owner_admin"])).toContain("/app/admin/settings");
    expect(keys(["owner_admin"])).toContain("/app/m/payroll");
  });

  it("operations sees collections but not payroll", () => {
    const k = keys(["operations"]);
    expect(k).toContain("/app/collections");
    expect(k).not.toContain("/app/m/payroll");
  });

  it("drops empty sections", () => {
    expect(navForRoles(["driver"])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { zIsoDate, zPeso, zPesoOrZero, zPhMobile } from "./validation";

describe("form validation", () => {
  it("zPeso parses to centavos and rejects junk", () => {
    expect(zPeso.parse(" 1,250.50 ")).toBe(BigInt(125050));
    expect(zPeso.safeParse("12.345").success).toBe(false);
    expect(zPeso.safeParse("").success).toBe(false);
  });
  it("zPesoOrZero treats blank as zero", () => {
    expect(zPesoOrZero.parse("")).toBe(BigInt(0));
  });
  it("zIsoDate", () => {
    expect(zIsoDate.parse("2026-10-01")).toBe("2026-10-01");
    expect(zIsoDate.safeParse("2026-02-30").success).toBe(false);
  });
  it("zPhMobile normalises common formats", () => {
    expect(zPhMobile.parse("0917 123 4567")).toBe("09171234567");
    expect(zPhMobile.parse("+639171234567")).toBe("09171234567");
    expect(zPhMobile.parse("639171234567")).toBe("09171234567");
    expect(zPhMobile.safeParse("12345").success).toBe(false);
  });
});

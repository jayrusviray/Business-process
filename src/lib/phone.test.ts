import { describe, expect, it } from "vitest";
import { phToE164, temporaryPassword } from "./phone";

describe("phone helpers", () => {
  it("converts PH mobiles to E.164", () => {
    expect(phToE164("09171234567")).toBe("+639171234567");
    expect(phToE164("0917 123 4567")).toBe("+639171234567");
    expect(phToE164("+639171234567")).toBe("+639171234567");
    expect(() => phToE164("12345")).toThrow();
  });
  it("makes readable temporary passwords", () => {
    const p = temporaryPassword();
    expect(p).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{2}$/);
    expect(p).not.toMatch(/[01ilo]/);
  });
});

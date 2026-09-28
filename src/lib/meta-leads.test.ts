import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapLeadFields, parseLeadgenChanges, verifyMetaSignature } from "./meta-leads";

describe("verifyMetaSignature", () => {
  const body = '{"object":"page"}';
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  it("accepts the right signature and rejects anything else", () => {
    expect(verifyMetaSignature("s3cret", body, good)).toBe(true);
    expect(verifyMetaSignature("other", body, good)).toBe(false);
    expect(verifyMetaSignature("s3cret", `${body} `, good)).toBe(false);
    expect(verifyMetaSignature("s3cret", body, null)).toBe(false);
    expect(verifyMetaSignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(verifyMetaSignature("", body, good)).toBe(false);
  });
});

describe("parseLeadgenChanges", () => {
  it("keeps only page leadgen changes", () => {
    const payload = {
      object: "page",
      entry: [
        { id: "p1", changes: [{ field: "leadgen", value: { leadgen_id: 444, page_id: "p1", form_id: "f1" } }, { field: "feed", value: {} }] },
        { id: "p1", changes: [{ field: "leadgen", value: { leadgen_id: "555" } }] },
      ],
    };
    expect(parseLeadgenChanges(payload)).toEqual([
      { leadgenId: "444", pageId: "p1", formId: "f1" },
      { leadgenId: "555", pageId: null, formId: null },
    ]);
    expect(parseLeadgenChanges({ object: "user", entry: [] })).toEqual([]);
    expect(parseLeadgenChanges(null)).toEqual([]);
  });
});

describe("mapLeadFields", () => {
  it("maps common Lead Ads fields and keeps the rest as extra notes", () => {
    const m = mapLeadFields([
      { name: "full_name", values: ["Maria Santos"] },
      { name: "phone_number", values: ["+639171234567"] },
      { name: "email", values: ["maria@example.com"] },
      { name: "city", values: ["Quezon City"] },
      { name: "what_service?", values: ["CPC renewal"] },
    ]);
    expect(m).toEqual({
      name: "Maria Santos",
      mobile: "09171234567",
      e164: "+639171234567",
      email: "maria@example.com",
      location: "Quezon City",
      extra: "what service?: CPC renewal",
    });
  });
  it("joins first and last names and survives junk", () => {
    expect(mapLeadFields([{ name: "first_name", values: ["Jo"] }, { name: "last_name", values: ["Reyes"] }]).name).toBe("Jo Reyes");
    expect(mapLeadFields("junk")).toMatchObject({ name: "Facebook lead", mobile: "", email: null });
  });
});

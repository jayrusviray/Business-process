import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvObjects } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, commas, escaped quotes, CRLF and BOM", () => {
    const text = '﻿name,trips\r\n"Dela Cruz, Juan",201\r\n"Said ""hi""",5\n';
    expect(parseCsv(text)).toEqual([["name", "trips"], ["Dela Cruz, Juan", "201"], ['Said "hi"', "5"]]);
  });
  it("skips blank lines and keeps empty fields", () => {
    expect(parseCsv("a,b\n\n1,\n")).toEqual([["a", "b"], ["1", ""]]);
  });
  it("rejects unterminated quotes", () => {
    expect(() => parseCsv('a\n"oops')).toThrow();
  });
  it("maps headers to normalised keys", () => {
    const { headers, rows } = parseCsvObjects("Mobile Number, Total Trips \n0917 123 4567,210");
    expect(headers).toEqual(["mobile_number", "total_trips"]);
    expect(rows).toEqual([{ mobile_number: "0917 123 4567", total_trips: "210" }]);
  });
});

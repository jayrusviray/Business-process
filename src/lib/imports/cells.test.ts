import { describe, expect, it } from "vitest";
import { pesos } from "../money";
import {
  cleanPlate,
  excelNumberToString,
  excelSerialToIso,
  FieldError,
  namesMatch,
  parseChoice,
  parseImportDate,
  parseImportInt,
  parseImportPeso,
  parseYesNo,
  plateKey,
  sheetDateToIso,
  splitList,
} from "./cells";

describe("excelNumberToString", () => {
  it("keeps integers exact, including mobile numbers that lost their leading zero", () => {
    expect(excelNumberToString(700)).toBe("700");
    expect(excelNumberToString(9171234567)).toBe("9171234567");
    expect(excelNumberToString(-2100)).toBe("-2100");
  });
  it("keeps up to two decimals as typed", () => {
    expect(excelNumberToString(1234.5)).toBe("1234.5");
    expect(excelNumberToString(0.05)).toBe("0.05");
  });
  it("snaps formula noise to the centavo", () => {
    expect(excelNumberToString(0.1 + 0.2)).toBe("0.3");
    expect(excelNumberToString(1234.5600000000002)).toBe("1234.56");
    expect(excelNumberToString(700 * 1.1)).toBe("770");
    expect(excelNumberToString(-0.1 - 0.2)).toBe("-0.3");
  });
  it("does not round genuine extra decimals (money validation then rejects them)", () => {
    expect(excelNumberToString(12.345)).toBe("12.345");
    expect(() => parseImportPeso(excelNumberToString(12.345))).toThrow(FieldError);
  });
});

describe("Excel serial dates", () => {
  it("converts 1900-system serials (Windows Excel)", () => {
    expect(excelSerialToIso(1)).toBe("1900-01-01");
    expect(excelSerialToIso(59)).toBe("1900-02-28");
    expect(excelSerialToIso(60)).toBeNull(); // Excel's fictitious 1900-02-29
    expect(excelSerialToIso(61)).toBe("1900-03-01");
    expect(excelSerialToIso(25569)).toBe("1970-01-01");
    expect(excelSerialToIso(46292)).toBe("2026-09-27");
    expect(excelSerialToIso(46292.75)).toBe("2026-09-27"); // a time of day is ignored
  });
  it("converts 1904-system serials (old Mac workbooks)", () => {
    expect(excelSerialToIso(0, true)).toBeNull();
    expect(excelSerialToIso(1, true)).toBe("1904-01-02");
    expect(excelSerialToIso(46292 - 1462, true)).toBe("2026-09-27");
  });
  it("reads date cells from their UTC calendar components", () => {
    expect(sheetDateToIso(new Date(Date.UTC(2026, 8, 27)))).toBe("2026-09-27");
    expect(sheetDateToIso(new Date(Date.UTC(2026, 8, 27, 23, 59)))).toBe("2026-09-27");
  });
});

describe("parseImportDate", () => {
  it("accepts ISO and compact dates", () => {
    expect(parseImportDate("2026-09-27")).toBe("2026-09-27");
    expect(parseImportDate("2026/9/7")).toBe("2026-09-07");
    expect(parseImportDate("2026-09-27T00:00:00")).toBe("2026-09-27");
    expect(parseImportDate("20260927")).toBe("2026-09-27");
  });
  it("reads slashed dates month-first (PH default) unless the first number is over 12", () => {
    expect(parseImportDate("9/27/2026")).toBe("2026-09-27");
    expect(parseImportDate("09/05/2026")).toBe("2026-09-05");
    expect(parseImportDate("27/09/2026")).toBe("2026-09-27");
    expect(parseImportDate("9-27-26")).toBe("2026-09-27");
    expect(parseImportDate("5/3/85")).toBe("1985-05-03");
    expect(parseImportDate("9/27/2026 0:00")).toBe("2026-09-27");
  });
  it("accepts month names", () => {
    expect(parseImportDate("Sep 27, 2026")).toBe("2026-09-27");
    expect(parseImportDate("September 27 2026")).toBe("2026-09-27");
    expect(parseImportDate("27 Sep 2026")).toBe("2026-09-27");
    expect(parseImportDate("27-Sep-26")).toBe("2026-09-27");
    expect(parseImportDate("Sept. 1, 2026")).toBe("2026-09-01");
  });
  it("accepts Excel serial numbers typed or exported as plain numbers", () => {
    expect(parseImportDate("46292")).toBe("2026-09-27");
    expect(parseImportDate("46292.5")).toBe("2026-09-27");
    expect(parseImportDate("44830", { date1904: true })).toBe("2026-09-27");
  });
  it("rejects impossible or ambiguous input", () => {
    for (const bad of ["2026-02-30", "13/13/2026", "2026", "yesterday", "Sep 31, 2026", "1/2", ""]) {
      expect(() => parseImportDate(bad), bad).toThrow(FieldError);
    }
  });
});

describe("parseImportPeso", () => {
  it("parses amounts as typed in PH sheets", () => {
    expect(parseImportPeso("700")).toBe(pesos(700));
    expect(parseImportPeso("1,250.50")).toBe(BigInt(125050));
    expect(parseImportPeso("₱ 700")).toBe(pesos(700));
    expect(parseImportPeso("P700.00")).toBe(pesos(700));
    expect(parseImportPeso("PHP 1,000")).toBe(pesos(1000));
    expect(parseImportPeso(" 700.5 ")).toBe(BigInt(70050));
  });
  it("reads negatives, including accounting parentheses", () => {
    expect(parseImportPeso("-500")).toBe(-pesos(500));
    expect(parseImportPeso("(500.00)")).toBe(-pesos(500));
    expect(parseImportPeso("-₱500")).toBe(-pesos(500));
    expect(parseImportPeso("₱-500")).toBe(-pesos(500));
  });
  it("rejects anything that is not an exact centavo amount", () => {
    for (const bad of ["", "abc", "1.234", "1.234,50", "12,34", "--5", "5-"]) {
      expect(() => parseImportPeso(bad), bad).toThrow(FieldError);
    }
  });
});

describe("small parsers", () => {
  it("whole numbers", () => {
    expect(parseImportInt("60", 1, 120)).toBe(60);
    expect(parseImportInt("60.0", 1, 120)).toBe(60);
    expect(() => parseImportInt("0", 1, 120)).toThrow(/between 1 and 120/);
    expect(() => parseImportInt("6.5", 1, 120)).toThrow(FieldError);
  });
  it("yes/no", () => {
    expect(parseYesNo("Yes")).toBe(true);
    expect(parseYesNo("")).toBe(false);
    expect(parseYesNo("n")).toBe(false);
    expect(() => parseYesNo("maybe")).toThrow(FieldError);
  });
  it("choices with aliases", () => {
    const aliases = { ev: "ev", electric: "ev", "boundary hulog": "rto" } as const;
    expect(parseChoice("Electric", aliases, "type")).toBe("ev");
    expect(parseChoice("Boundary-Hulog", aliases, "type")).toBe("rto");
    expect(() => parseChoice("diesel", aliases, "type")).toThrow(/not a valid type \(use ev, rto\)/);
  });
  it("plates and lists", () => {
    expect(cleanPlate(" nbc  1234 ")).toBe("NBC 1234");
    expect(plateKey("NBC-1234")).toBe(plateKey("nbc 1234"));
    expect(splitList("NBC 1234; NBC 5678,  ,NDX 1")).toEqual(["NBC 1234", "NBC 5678", "NDX 1"]);
  });
  it("loose name matching", () => {
    expect(namesMatch("Dela Cruz, Juan", "Juan Dela Cruz")).toBe(true);
    expect(namesMatch("Juan", "Juan Dela Cruz")).toBe(true);
    expect(namesMatch("José Peña", "Jose Pena")).toBe(true);
    expect(namesMatch("Maria Santos", "Juan Dela Cruz")).toBe(false);
  });
});

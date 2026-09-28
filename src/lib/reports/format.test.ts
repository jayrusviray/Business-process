import { describe, expect, it } from "vitest";
import { pesos } from "../money";
import { computeTotals, excelCell, formatCell, pdfCell, plainCell, toCsv, type ReportColumn } from "./format";

const cols: ReportColumn[] = [
  { key: "name", label: "Driver", type: "text" },
  { key: "due", label: "Due", type: "date" },
  { key: "amount", label: "Amount", type: "money", total: true },
  { key: "days", label: "Days", type: "int", total: true },
  { key: "rate", label: "Rate", type: "pct" },
];

describe("cell formatting", () => {
  it("formats money, ints, dates and percentages", () => {
    expect(formatCell("money", pesos(1234) + BigInt(5))).toBe("₱1,234.05");
    expect(formatCell("money", "-150")).toBe("-₱1.50");
    expect(formatCell("int", 12345)).toBe("12,345");
    expect(formatCell("pct", 9876)).toBe("98.8%");
    expect(formatCell("pct", null)).toBe("—");
    expect(formatCell("date", "2026-09-30")).toBe("2026-09-30");
    expect(formatCell("text", null)).toBe("");
  });

  it("PDFs print PHP instead of ₱", () => {
    expect(pdfCell("money", pesos(700))).toBe("PHP 700.00");
    expect(pdfCell("money", -pesos(700))).toBe("-PHP 700.00");
  });

  it("plain values keep every centavo", () => {
    expect(plainCell("money", BigInt("123456789012345"))).toBe("1234567890123.45");
    expect(plainCell("pct", 1250)).toBe("12.50");
  });

  it("Excel cells: pesos as numbers, pct as fractions, dates as dates", () => {
    expect(excelCell("money", pesos(1_500) + BigInt(25))).toBe(1500.25);
    expect(excelCell("pct", 2500)).toBe(0.25);
    expect(excelCell("date", "2026-09-30")).toEqual(new Date("2026-09-30T00:00:00Z"));
    expect(excelCell("text", null)).toBeNull();
  });
});

describe("totals", () => {
  it("sums marked columns exactly and labels the first text column", () => {
    const rows = [
      { name: "A", due: "2026-09-01", amount: BigInt("900719925474099300"), days: 2, rate: 5000 },
      { name: "B", due: "2026-09-02", amount: BigInt(7), days: 3, rate: null },
    ];
    expect(computeTotals(cols, rows)).toEqual({ name: "Total", amount: BigInt("900719925474099307"), days: 5 });
  });
  it("no total columns → no totals row", () => {
    expect(computeTotals([{ key: "x", label: "X", type: "text" }], [{ x: "a" }])).toBeNull();
  });
});

describe("toCsv", () => {
  it("writes a header, rows and totals, quoting where needed", () => {
    const csv = toCsv(cols, [{ name: 'Cruz, "Jun"', due: "2026-09-01", amount: pesos(700), days: 1, rate: 10000 }], { name: "Total", amount: pesos(700), days: 1 });
    expect(csv).toBe(
      'Driver,Due,Amount,Days,Rate\r\n"Cruz, ""Jun""",2026-09-01,700.00,1,100.00\r\nTotal,,700.00,1,\r\n',
    );
  });
  it("neutralises spreadsheet formulas in text but keeps negative numbers", () => {
    const csv = toCsv([{ key: "t", label: "T", type: "text" }, { key: "m", label: "M", type: "money" }], [{ t: "=HYPERLINK(1)", m: -pesos(5) }]);
    expect(csv.split("\r\n")[1]).toBe("'=HYPERLINK(1),-5.00");
  });
});

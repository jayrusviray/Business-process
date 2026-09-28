import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseImportDate, parseImportPeso } from "@/lib/imports/cells";
import { pesos } from "@/lib/money";
import { decodeCsv, ImportFileError, readImportFile, sha256Hex } from "./read";

async function xlsxBytes(build: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Drivers");
  build(ws, wb);
  wb.addWorksheet("Ignored").addRow(["this sheet is not read"]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("readImportFile: Excel", () => {
  it("reads the first sheet with typed cells as text", async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(["Name", "Mobile Number", "Paid On", "Amount", "Serial Date", "Due"]);
      ws.addRow([
        { richText: [{ text: "Juan " }, { text: "Dela Cruz" }] },
        9171234567, // typed as a number: Excel drops the leading zero
        new Date(Date.UTC(2026, 8, 27)),
        { formula: "700*3", result: 2100 },
        46292, // a date typed into a plain number cell
        { formula: "0.1+0.2", result: 0.1 + 0.2 },
      ]);
      ws.addRow([]); // blank row
      ws.addRow(["Maria Santos", "0918 123 4567", "9/27/2026", "₱1,250.50", "", { error: "#N/A" }]);
    });
    const t = await readImportFile("drivers.xlsx", bytes);
    expect(t.headers).toEqual(["name", "mobile_number", "paid_on", "amount", "serial_date", "due"]);
    expect(t.date1904).toBe(false);
    expect(t.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(t.rows[0].values).toEqual({
      name: "Juan Dela Cruz",
      mobile_number: "9171234567",
      paid_on: "2026-09-27",
      amount: "2100",
      serial_date: "46292",
      due: "0.3",
    });
    expect(parseImportDate(t.rows[0].values.serial_date)).toBe("2026-09-27");
    expect(parseImportPeso(t.rows[1].values.amount)).toBe(BigInt(125050));
    expect(t.rows[1].values.due).toBe("#N/A");
  });

  it("knows 1904-based workbooks", async () => {
    const bytes = await xlsxBytes((ws, wb) => {
      wb.properties.date1904 = true;
      ws.addRow(["paid_on"]);
      ws.addRow([44830]);
    });
    const t = await readImportFile("old-mac.xlsx", bytes);
    expect(t.date1904).toBe(true);
    expect(parseImportDate(t.rows[0].values.paid_on, { date1904: t.date1904 })).toBe("2026-09-27");
  });

  it("detects an Excel file by content even with the wrong extension", async () => {
    const bytes = await xlsxBytes((ws) => {
      ws.addRow(["amount"]);
      ws.addRow([700]);
    });
    const t = await readImportFile("export.csv", bytes);
    expect(parseImportPeso(t.rows[0].values.amount)).toBe(pesos(700));
  });

  it("refuses broken or old-format files", async () => {
    await expect(readImportFile("x.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toThrow(ImportFileError);
    await expect(readImportFile("x.xls", new Uint8Array([0xd0, 0xcf, 0x11]))).rejects.toThrow(/Old .xls files/);
    await expect(readImportFile("x.csv", new Uint8Array())).rejects.toThrow(/empty/);
  });
});

describe("readImportFile: CSV", () => {
  it("keeps real line numbers across blank lines and multi-line cells", async () => {
    const csv = 'name,notes\r\nJuan,"two\nlines"\r\n\r\nMaria,ok\r\n';
    const t = await readImportFile("x.csv", new TextEncoder().encode(csv));
    expect(t.rows).toEqual([
      { line: 2, values: { name: "Juan", notes: "two\nlines" } },
      { line: 5, values: { name: "Maria", notes: "ok" } },
    ]);
  });

  it("reads Windows-1252 files saved by Excel (ñ in Filipino names)", () => {
    const cp1252 = new Uint8Array([0x50, 0x65, 0xf1, 0x61]); // "Peña"
    expect(decodeCsv(cp1252)).toBe("Peña");
    expect(decodeCsv(new TextEncoder().encode("Peña"))).toBe("Peña");
  });

  it("refuses duplicate headers and too many rows", async () => {
    await expect(readImportFile("x.csv", new TextEncoder().encode("Mobile,mobile\n1,2\n"))).rejects.toThrow(/appears twice/);
    const big = `a\n${"1\n".repeat(2001)}`;
    await expect(readImportFile("x.csv", new TextEncoder().encode(big))).rejects.toThrow(/at most 2,000 rows/);
  });

  it("hashes content for the already-imported check", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

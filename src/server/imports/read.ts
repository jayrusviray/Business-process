import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { normalizeHeader, parseCsvLines } from "@/lib/csv";
import { excelNumberToString, sheetDateToIso } from "@/lib/imports/cells";
import type { RawRow } from "@/lib/imports/rows";

/** A spreadsheet reduced to text cells keyed by normalised header. */
export type SheetTable = {
  headers: string[];
  rows: RawRow[];
  /** The workbook counts dates from 1904 (old Mac Excel); affects serial numbers in plain number cells. */
  date1904: boolean;
};

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Text of a CSV file. Excel on Windows saves "CSV (Comma delimited)" in
 * Windows-1252, where Filipino names such as "Peña" are not valid UTF-8.
 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function tableFromCells(records: { line: number; cells: string[] }[], date1904: boolean): SheetTable {
  const [head, ...body] = records;
  if (!head) throw new ImportFileError("The file is empty.");
  const headers = head.cells.map(normalizeHeader);
  const dupe = headers.find((h, i) => h && headers.indexOf(h) !== i);
  if (dupe) throw new ImportFileError(`The column "${dupe}" appears twice in the header row.`);
  if (body.length > MAX_IMPORT_ROWS) throw new ImportFileError(`Import at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows at a time (this file has ${body.length}).`);
  const rows = body.map((r) => ({
    line: r.line,
    values: Object.fromEntries(headers.map((h, i) => [h, (r.cells[i] ?? "").trim()]).filter(([h]) => h !== "")),
  }));
  return { headers: headers.filter(Boolean), rows, date1904 };
}

/** One Excel cell as text (see excelNumberToString for numbers; dates become YYYY-MM-DD). */
export function excelCellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return excelNumberToString(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : sheetDateToIso(v);
  if ("richText" in v) return v.richText.map((t) => t.text).join("").trim();
  if ("hyperlink" in v) return String(v.text ?? "").trim();
  if ("error" in v) return v.error;
  if ("formula" in v || "sharedFormula" in v) return v.result === undefined ? "" : excelCellText(v.result as ExcelJS.CellValue);
  return "";
}

async function readXlsx(bytes: Uint8Array): Promise<SheetTable> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw new ImportFileError("Could not read this Excel file. Save it as .xlsx (Excel Workbook) or .csv and try again.");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportFileError("The workbook has no sheets.");
  const records: { line: number; cells: string[] }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(excelCellText(row.getCell(c).value));
    if (cells.some((x) => x !== "")) records.push({ line: rowNumber, cells });
  });
  const date1904 = Boolean((wb.properties as { date1904?: boolean } | undefined)?.date1904);
  return tableFromCells(records, date1904);
}

/** Reads the first sheet of an .xlsx, or a .csv, into text rows with their spreadsheet line numbers. */
export async function readImportFile(fileName: string, bytes: Uint8Array): Promise<SheetTable> {
  if (bytes.byteLength === 0) throw new ImportFileError("The file is empty.");
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportFileError("The file is too large (max 5 MB). Split it into smaller files.");
  const name = fileName.toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; // .xlsx is a zip archive
  if (name.endsWith(".xlsx") || isZip) return readXlsx(bytes);
  if (name.endsWith(".xls")) throw new ImportFileError("Old .xls files are not supported. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV.");
  let records: { line: number; cells: string[] }[];
  try {
    records = parseCsvLines(decodeCsv(bytes));
  } catch (e) {
    throw new ImportFileError(e instanceof Error ? `Could not read the CSV file: ${e.message}.` : "Could not read the CSV file.");
  }
  return tableFromCells(records, false);
}

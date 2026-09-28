/**
 * Regenerates the Excel import files:
 *   - public/templates/<kind>.xlsx from the CSV templates (+ an "Instructions" sheet)
 *   - docs/import-samples/02-drivers.xlsx (a sample with real Excel cell types:
 *     date cells, a mobile typed as a number, a date typed as text)
 * Usage: npm run import:files
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseCsv } from "../src/lib/csv";
import { IMPORT_KIND_INFO, IMPORT_KINDS, templateName } from "../src/lib/imports/kinds";

const root = path.join(__dirname, "..");

async function templates() {
  for (const kind of IMPORT_KINDS) {
    const info = IMPORT_KIND_INFO[kind];
    const csv = parseCsv(readFileSync(path.join(root, "public/templates", `${templateName(kind)}.csv`), "utf8"));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(info.label);
    for (const r of csv) ws.addRow(r);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 18));
    const help = wb.addWorksheet("Instructions");
    help.addRow(["Only the FIRST sheet is imported. Keep the header row; extra columns are ignored."]);
    help.addRow([]);
    help.addRow(["Column", "Required", "What to put"]).font = { bold: true };
    for (const c of info.columns) help.addRow([c.key, c.required ? "yes" : "", c.hint]);
    help.addRow([]);
    for (const d of info.details) help.addRow([d]);
    help.getColumn(1).width = 24;
    help.getColumn(3).width = 90;
    await wb.xlsx.writeFile(path.join(root, "public/templates", `${templateName(kind)}.xlsx`));
  }
}

async function driversSample() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Drivers");
  ws.addRow(["Name", "Mobile Number", "Email", "Address", "Birthday", "License No", "License Expiry", "Emergency Contact", "Emergency Phone", "Status", "Language"]);
  const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
  const rows: ExcelJS.CellValue[][] = [
    ["Ramil Bautista", "0917 555 1001", "", "Quezon City", d(1986, 2, 14), "N01-10-111111", d(2028, 2, 14), "Liza Bautista", "0918 000 1001", "active", "taglish"],
    ["Jerome Villanueva", "09175551002", "jerome.v@example.com", "Marikina", d(1991, 7, 3), "N01-12-222222", d(2027, 7, 3), "", "", "active", "en"],
    ["Arnel Garcia", 9175551003, "", "Pasig", "05/12/1990", "N02-15-333333", d(2029, 5, 12), "Rosa Garcia", "0918 000 1003", "Active", ""],
    ["Christian Mendoza", "+63 917 555 1004", "", "Taguig", d(1993, 11, 30), "N03-18-444444", d(2027, 11, 30), "", "", "active", "taglish"],
    ["Mark Anthony Reyes", "0917-555-1005", "", "Caloocan", d(1989, 1, 8), "N01-09-555555", d(2026, 12, 8), "", "", "active", "tagalog"],
    ["Joel Ramos", "0917 555 1006", "", "Malabon", d(1984, 9, 21), "N04-07-666666", d(2026, 9, 21), "", "", "suspended", ""],
  ];
  for (const r of rows) ws.addRow(r);
  for (const c of [5, 7]) ws.getColumn(c).numFmt = "mm/dd/yyyy";
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(path.join(root, "docs/import-samples/02-drivers.xlsx"));
}

async function main() {
  await templates();
  await driversSample();
  console.log("Import templates and samples written.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

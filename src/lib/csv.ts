/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM).
 * Used for platform report imports, the CRM lead import and the spreadsheet import.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvLines(text).map((r) => r.cells);
}

/**
 * Like parseCsv, but each record also carries the physical line it starts on
 * (1-based), so import previews can point at the right spreadsheet row even
 * when blank lines are skipped or a quoted field spans several lines.
 */
export function parseCsvLines(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ line: rowStart, cells: row });
      row = [];
      field = "";
      line++;
      rowStart = line;
    } else field += ch;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push({ line: rowStart, cells: row });
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}

/** Header cell → key: lowercase, runs of other characters become "_" (e.g. "Plate No." → "plate_no"). */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Parse with a header row → objects keyed by normalised header (lowercase, underscores). */
export function parseCsvObjects(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const [head, ...body] = parseCsv(text);
  if (!head) return { headers: [], rows: [] };
  const headers = head.map(normalizeHeader);
  return {
    headers,
    rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))),
  };
}

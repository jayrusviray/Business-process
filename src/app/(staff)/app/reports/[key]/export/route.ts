import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { reportCsv, reportPdf, reportXlsx } from "@/server/reports/export";
import { findReport } from "@/server/reports/registry";
import { runReport } from "@/server/reports/run";
import { resolveContext } from "@/server/reports/types";

const TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
} as const;

/** /app/reports/[key]/export?format=xlsx|pdf|csv&from=…&to=…&<params>. Runs as the user (RLS). */
export async function GET(req: NextRequest, ctx: RouteContext<"/app/reports/[key]/export">) {
  const { key } = await ctx.params;
  const def = findReport(key);
  if (!def) return new NextResponse("Not found", { status: 404 });
  const session = await getSession();
  if (!session || !hasAnyRole(session.roles, def.roles)) return new NextResponse("Unauthorized", { status: 401 });
  const format = req.nextUrl.searchParams.get("format") ?? "xlsx";
  if (!(format in TYPES)) return new NextResponse("Unknown format", { status: 400 });
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());

  const file = await withUserTx(session.claims, async (tx) => {
    const { ctx: rctx } = await resolveContext(tx, def, sp, { today: businessToday(), userId: session.userId, roles: session.roles });
    const stem = `${def.key}-${rctx.from === rctx.to ? rctx.to : `${rctx.from}-to-${rctx.to}`}`;
    if (format === "pdf" && def.pdf) {
      const custom = await def.pdf(tx, rctx);
      if (custom) return { data: custom.data, filename: custom.filename };
    }
    if (format === "xlsx" && def.xlsx) {
      const custom = await def.xlsx(tx, rctx);
      if (custom) return { data: custom.data, filename: custom.filename };
    }
    const doc = await runReport(tx, def, rctx);
    const data = format === "pdf" ? await reportPdf(doc) : format === "csv" ? reportCsv(doc) : await reportXlsx(doc);
    return { data, filename: `${stem}.${format}` };
  });
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "content-type": TYPES[format as keyof typeof TYPES],
      "content-disposition": `${format === "pdf" ? "inline" : "attachment"}; filename="${file.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}

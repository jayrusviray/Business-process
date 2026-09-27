import "server-only";
import { NextResponse } from "next/server";
import { withUserTx, type JwtClaims } from "@/db/client";
import { addMonths, businessToday, isIsoDate, startOfMonth, type IsoDate } from "@/lib/dates";
import { renderStatementPdf } from "@/server/pdf/statement";

/** Shared handler: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: start of last month → today). */
export async function statementResponse(claims: JwtClaims, driverId: string, url: URL): Promise<NextResponse> {
  const today = businessToday();
  const qFrom = url.searchParams.get("from") ?? "";
  const qTo = url.searchParams.get("to") ?? "";
  const from = (isIsoDate(qFrom) ? qFrom : addMonths(startOfMonth(today), -1)) as IsoDate;
  const to = (isIsoDate(qTo) ? qTo : today) as IsoDate;
  if (to < from) return new NextResponse("Invalid period", { status: 400 });
  const pdf = await withUserTx(claims, (tx) => renderStatementPdf(tx, driverId, from, to));
  if (!pdf) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="statement-${from}-to-${to}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}

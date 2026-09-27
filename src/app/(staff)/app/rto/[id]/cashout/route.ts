import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { businessToday, isIsoDate, type IsoDate } from "@/lib/dates";
import { renderCashoutPdf } from "@/server/pdf/cashout";

export async function GET(req: NextRequest, ctx: RouteContext<"/app/rto/[id]/cashout">) {
  const session = await getSession();
  if (!session || !hasAnyRole(session.roles, ["owner_admin", "finance", "operations"])) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const q = req.nextUrl.searchParams.get("asOf") ?? "";
  const asOf = (isIsoDate(q) ? q : businessToday()) as IsoDate;
  const pdf = await withUserTx(session.claims, (tx) => renderCashoutPdf(tx, id, asOf));
  if (!pdf) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="cashout-${asOf}.pdf"`, "cache-control": "private, no-store" },
  });
}

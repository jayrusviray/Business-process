import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { getSession } from "@/lib/auth/session";
import { endOfMonth, isIsoDate, type IsoDate } from "@/lib/dates";
import { renderInvestorStatementPdf } from "@/server/pdf/investor-statement";

/**
 * The signed-in investor's monthly statement (PDF): ?month=YYYY-MM.
 * RLS limits the rows to the investor's own payouts; no investor id is taken from the URL.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.roles.includes("investor")) return new NextResponse("Unauthorized", { status: 401 });
  const month = `${req.nextUrl.searchParams.get("month") ?? ""}-01`;
  if (!isIsoDate(month)) return new NextResponse("Invalid month", { status: 400 });
  const pdf = await withUserTx(session.claims, async (tx) => {
    const [me] = await tx.execute<{ id: string | null }>(sql`SELECT app.current_investor_id() AS id`);
    if (!me?.id) return null;
    return renderInvestorStatementPdf(tx, { investorId: me.id, from: month as IsoDate, to: endOfMonth(month as IsoDate) });
  });
  if (!pdf) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="investor-statement-${month.slice(0, 7)}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}

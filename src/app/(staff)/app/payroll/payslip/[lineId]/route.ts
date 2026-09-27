import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { getSession } from "@/lib/auth/session";
import { renderPayslipPdf } from "@/server/pdf/payslip";

/** Payslip PDF. RLS decides visibility: finance/admin, or the employee for their own finalized slip. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/app/payroll/payslip/[lineId]">) {
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const { lineId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(lineId)) return new NextResponse("Not found", { status: 404 });
  const pdf = await withUserTx(session.claims, (tx) => renderPayslipPdf(tx, lineId));
  if (!pdf) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="payslip.pdf"`, "cache-control": "private, no-store" },
  });
}

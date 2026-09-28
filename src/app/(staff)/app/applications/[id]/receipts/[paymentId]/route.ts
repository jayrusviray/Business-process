import { NextResponse, type NextRequest } from "next/server";
import { hasAnyRole } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { receiptResponse } from "@/server/receipt-route";

/** Acknowledgement receipt PDF for an application fee payment (visibility via RLS). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/app/applications/[id]/receipts/[paymentId]">) {
  const session = await getSession();
  if (!session || !hasAnyRole(session.roles, ["owner_admin", "operations", "sales", "documentation", "finance"])) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { paymentId } = await ctx.params;
  return receiptResponse(session.claims, paymentId, "application");
}

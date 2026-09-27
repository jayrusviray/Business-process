import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { receiptResponse } from "@/server/receipt-route";

/** A driver's own receipt (RLS limits payments to the signed-in driver). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/portal/receipts/[id]">) {
  const session = await getSession();
  if (!session?.roles.includes("driver")) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  return receiptResponse(session.claims, id);
}

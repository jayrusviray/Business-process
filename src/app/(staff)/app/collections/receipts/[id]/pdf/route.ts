import { NextResponse, type NextRequest } from "next/server";
import { hasAnyRole } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { receiptResponse } from "@/server/receipt-route";

export async function GET(_req: NextRequest, ctx: RouteContext<"/app/collections/receipts/[id]/pdf">) {
  const session = await getSession();
  if (!session || !hasAnyRole(session.roles, ["owner_admin", "finance", "operations"])) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  return receiptResponse(session.claims, id);
}

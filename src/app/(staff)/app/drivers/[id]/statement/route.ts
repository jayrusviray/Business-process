import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hasAnyRole } from "@/lib/auth/roles";
import { statementResponse } from "@/server/statement-route";

export async function GET(req: NextRequest, ctx: RouteContext<"/app/drivers/[id]/statement">) {
  const session = await getSession();
  if (!session || !hasAnyRole(session.roles, ["owner_admin", "finance", "operations"])) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  return statementResponse(session.claims, id, req.nextUrl);
}

import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { getSession } from "@/lib/auth/session";
import { exportLead } from "@/server/crm/leads";

/** Data-subject access request: everything held about a lead, as JSON (owner/admin; logged). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/app/crm/[id]/export">) {
  const session = await getSession();
  if (!session?.roles.includes("owner_admin")) return new NextResponse("Forbidden", { status: 403 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const data = await withUserTx(session.claims, (tx) => exportLead(tx, id, session.userId));
  if (!data) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="lead-${id}.json"`,
      "cache-control": "private, no-store",
    },
  });
}

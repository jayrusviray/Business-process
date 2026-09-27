import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { payrollRegisterXlsx } from "@/server/xlsx/payroll-register";

export async function GET(_req: NextRequest, ctx: RouteContext<"/app/payroll/[id]/register">) {
  const session = await getSession();
  if (!session || !hasAnyRole(session.roles, ["owner_admin", "finance"])) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const buf = await withUserTx(session.claims, (tx) => payrollRegisterXlsx(tx, id));
  if (!buf) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="payroll-register.xlsx"`,
      "cache-control": "private, no-store",
    },
  });
}

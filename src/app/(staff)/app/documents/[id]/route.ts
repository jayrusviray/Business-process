import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { getSession } from "@/lib/auth/session";
import { signedDocumentUrl } from "@/server/documents";

/** Opens a private document through a short-lived signed URL (access is logged). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/app/documents/[id]">) {
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const url = await withUserTx(session.claims, (tx) => signedDocumentUrl(tx, id, session.userId));
  if (!url) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(url, { status: 303 });
}

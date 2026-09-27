import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { notifications } from "@/db/schema";
import { getSession } from "@/lib/auth/session";

/** Opens a notification: marks it read (own rows only, RLS) and goes to its link inside the app. */
export async function GET(req: NextRequest, ctx: RouteContext<"/app/notifications/[id]">) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const [n] = await withUserTx(session.claims, (tx) =>
    tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.userId, session.userId))).returning(),
  );
  const target = n?.link && n.link.startsWith("/app/") && !n.link.startsWith("//") ? n.link : "/app/notifications";
  return NextResponse.redirect(new URL(target, req.url), { status: 303 });
}

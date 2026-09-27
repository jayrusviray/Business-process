import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { withUserTx } from "@/db/client";
import { drivers } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { statementResponse } from "@/server/statement-route";

/** The signed-in driver's own statement of account (PDF). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.roles.includes("driver")) return new NextResponse("Unauthorized", { status: 401 });
  const [me] = await withUserTx(session.claims, (tx) =>
    tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.profileId, session.userId)),
  );
  if (!me) return new NextResponse("Not found", { status: 404 });
  return statementResponse(session.claims, me.id, req.nextUrl);
}

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withSystemTx } from "@/db/client";

export const dynamic = "force-dynamic";

/** Uptime check: the app is up and the database answers. Public, and reveals nothing else. */
export async function GET() {
  const at = new Date().toISOString();
  try {
    await withSystemTx("health", (tx) => tx.execute(sql`SELECT 1`));
    return NextResponse.json({ ok: true, db: "ok", at }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("health check failed", e);
    return NextResponse.json({ ok: false, db: "error", at }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

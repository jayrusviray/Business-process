import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/db/client";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { businessToday } from "@/lib/dates";
import { generateReminders } from "@/server/reminders";

export const dynamic = "force-dynamic";

/** Vercel Cron, 08:00 Manila: builds today's reminders into the outbox for staff to send. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await withSystemTx("cron:reminders", (tx) => generateReminders(tx, businessToday()));
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("reminders failed", e);
    return NextResponse.json({ ok: false, error: "reminder generation failed" }, { status: 500 });
  }
}

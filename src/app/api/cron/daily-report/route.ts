import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/db/client";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { businessToday } from "@/lib/dates";
import { sendDailyCollectionEmail } from "@/server/email/daily-report";
import { getEmailProvider } from "@/server/email/provider";

export const dynamic = "force-dynamic";

/**
 * Vercel Cron, 21:00 Manila: emails today's Daily Collection Report. Off
 * (returns "skipped") until setting reports.daily_email_to has addresses and
 * RESEND_API_KEY + REPORTS_EMAIL_FROM are set.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await withSystemTx("cron:daily-report", (tx) => sendDailyCollectionEmail(tx, businessToday(), getEmailProvider()));
    if (r.status === "failed") console.error("daily-report email failed", r.error);
    return NextResponse.json({ ok: r.status !== "failed", status: r.status, rows: r.rows ?? 0 }, { status: r.status === "failed" ? 502 : 200 });
  } catch (e) {
    console.error("daily-report failed", e);
    return NextResponse.json({ ok: false, error: "daily report failed" }, { status: 500 });
  }
}

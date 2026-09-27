import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/db/client";
import { chargeRuns } from "@/db/schema";
import { businessToday } from "@/lib/dates";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { runDailyCharges } from "@/server/money/charges";

export const dynamic = "force-dynamic";

/** Vercel Cron → posts today's boundary charges (and any missed days). See vercel.json. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const today = businessToday();
  try {
    const result = await withSystemTx("cron:daily-charges", (tx) => runDailyCharges(tx, today, "cron:daily-charges"));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Record the failure outside the rolled-back transaction so staff can see it.
    await withSystemTx("cron:daily-charges", (tx) =>
      tx.insert(chargeRuns).values({ fromDate: today, toDate: today, status: "failed", triggeredBy: "cron:daily-charges", error: message.slice(0, 500), finishedAt: new Date() }),
    ).catch(() => {});
    console.error("daily-charges failed", e);
    return NextResponse.json({ ok: false, error: "charge run failed" }, { status: 500 });
  }
}

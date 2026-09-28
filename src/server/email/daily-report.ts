import "server-only";
import type { Tx } from "@/db/client";
import type { IsoDate } from "@/lib/dates";
import { formatPeso, ZERO } from "@/lib/money";
import { reportXlsx } from "@/server/reports/export";
import { dailyCollection } from "@/server/reports/collections";
import { runReport } from "@/server/reports/run";
import { resolveContext } from "@/server/reports/types";
import { getSetting } from "@/server/office/settings";
import type { EmailProvider, EmailResult } from "./provider";

/**
 * Emails the Daily Collection Report for `date` (Excel attached) to the
 * addresses in setting reports.daily_email_to. Does nothing unless both the
 * setting and an email provider are configured. Runs as the system (cron).
 */
export async function sendDailyCollectionEmail(tx: Tx, date: IsoDate, provider: EmailProvider): Promise<EmailResult & { rows?: number }> {
  const to = await getSetting(tx, "reports.daily_email_to");
  if (to.length === 0 || !provider.configured) return { status: "skipped" };
  const { ctx } = await resolveContext(tx, dailyCollection, { from: date, to: date }, { today: date, userId: "system", roles: ["owner_admin"] });
  const doc = await runReport(tx, dailyCollection, ctx);
  const t = doc.totals ?? {};
  const due = typeof t.expected === "bigint" ? t.expected : ZERO;
  const paid = typeof t.paid === "bigint" ? t.paid : ZERO;
  const unpaid = doc.rows.filter((r) => typeof r.paid === "bigint" && r.paid === ZERO && typeof r.expected === "bigint" && r.expected > ZERO).length;
  const text = [
    `Daily Collection Report — ${date}`,
    ``,
    `Due that day: ${formatPeso(due)}`,
    `Paid that day: ${formatPeso(paid)}`,
    `Drivers with dues and no payment: ${unpaid}`,
    ``,
    `The full report is attached (Excel). Open it in the app: /app/reports/daily-collection?from=${date}&to=${date}`,
  ].join("\n");
  const res = await provider.send({
    to,
    subject: `Daily collections ${date}: ${formatPeso(paid)} paid of ${formatPeso(due)} due`,
    text,
    attachments: [{ filename: `daily-collection-${date}.xlsx`, content: await reportXlsx(doc) }],
  });
  return { ...res, rows: doc.rows.length };
}

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { withSystemTx } from "@/db/client";
import { appSettings } from "@/db/schema";
import { parseLeadgenChanges, verifyMetaSignature } from "@/lib/meta-leads";
import { fetchLeadgen, ingestFacebookLead } from "@/server/crm/meta";

/**
 * Facebook Lead Ads webhook (Page subscription, field "leadgen"). Behind the
 * `crm.meta_lead_ads_enabled` setting and the META_* environment variables.
 */
async function enabled(): Promise<boolean> {
  if (!process.env.META_APP_SECRET || !process.env.META_VERIFY_TOKEN) return false;
  const [row] = await withSystemTx("webhook:meta", (tx) =>
    tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "crm.meta_lead_ads_enabled")),
  );
  return row?.value === true;
}

/** Meta's subscription check: echo hub.challenge when the verify token matches. */
export async function GET(req: NextRequest) {
  if (!(await enabled())) return new NextResponse("Not found", { status: 404 });
  const p = req.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === process.env.META_VERIFY_TOKEN) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyMetaSignature(process.env.META_APP_SECRET ?? "", raw, req.headers.get("x-hub-signature-256"))) {
    return new NextResponse("Invalid signature", { status: 401 });
  }
  if (!(await enabled())) return NextResponse.json({ ignored: true });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad JSON", { status: 400 });
  }
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  const results: Record<string, string> = {};
  for (const change of parseLeadgenChanges(payload)) {
    try {
      if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not set");
      const lead = await fetchLeadgen(change.leadgenId, token);
      results[change.leadgenId] = await withSystemTx("webhook:meta", (tx) => ingestFacebookLead(tx, { leadgenId: change.leadgenId, ...lead }));
    } catch (e) {
      // Log and keep going; Meta retries failed deliveries, and ingestion is idempotent.
      console.error("meta leadgen", change.leadgenId, e);
      results[change.leadgenId] = "error";
    }
  }
  const failed = Object.values(results).includes("error");
  return NextResponse.json({ results }, { status: failed ? 500 : 200 });
}

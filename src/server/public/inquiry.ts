import "server-only";
import { createHmac } from "node:crypto";
import { and, count, eq, gt } from "drizzle-orm";
import { withSystemTx } from "@/db/client";
import { appSettings, publicSubmissions } from "@/db/schema";
import type { ContactMethod, ServiceLine } from "@/lib/crm";
import { recordInquiry } from "../crm/leads";

export class RateLimitedError extends Error {
  constructor() {
    super("Too many submissions. Please try again later or message us on Facebook.");
    this.name = "RateLimitedError";
  }
}

/** Salted hash of the visitor IP: enough for rate limiting, useless for tracking anyone. */
export function hashIp(ip: string): string {
  const salt = process.env.RATE_LIMIT_SALT || process.env.SUPABASE_SECRET_KEY || "transrev";
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32);
}

export type Inquiry = {
  name: string;
  mobile: string;
  email: string | null;
  location: string;
  interest: ServiceLine;
  preferredContact: ContactMethod;
  message: string;
  kind?: "inquiry" | "application";
};

/**
 * Website inquiry → CRM lead (source "landing page form"), or a new entry on the
 * timeline of that person's open lead. Rate-limited per visitor.
 */
export async function submitInquiry(input: Inquiry, ipHash: string): Promise<{ leadId: string; duplicate: boolean }> {
  return withSystemTx("public:inquiry", async (tx) => {
    const [limit] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "crm.inquiry_rate_limit_per_hour"));
    const max = typeof limit?.value === "number" ? limit.value : 5;
    const [recent] = await tx
      .select({ n: count() })
      .from(publicSubmissions)
      .where(and(eq(publicSubmissions.ipHash, ipHash), gt(publicSubmissions.createdAt, new Date(Date.now() - 3600_000))));
    if ((recent?.n ?? 0) >= max) throw new RateLimitedError();
    const res = await recordInquiry(tx, {
      name: input.name,
      mobile: input.mobile,
      email: input.email,
      source: "landing_page",
      interest: input.interest,
      location: input.location,
      preferredContact: input.preferredContact,
      message: input.message,
      consentAt: new Date(),
    });
    await tx.insert(publicSubmissions).values({ kind: input.kind ?? "inquiry", ipHash, leadId: res.leadId });
    return res;
  });
}

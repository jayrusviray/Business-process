"use server";

import { headers } from "next/headers";
import { InquiryInput } from "@/lib/inquiry";
import { hashIp, RateLimitedError, submitInquiry } from "@/server/public/inquiry";

export type InquiryState = { ok?: boolean; error?: string };

/** The visitor's IP as seen by the hosting proxy (first hop of x-forwarded-for). */
async function visitorIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Public inquiry form → CRM lead. Honeypot + per-visitor rate limit against spam. */
export async function submitInquiryAction(_: InquiryState, formData: FormData): Promise<InquiryState> {
  // Honeypot: a field people never see. Bots fill it; pretend all went well.
  if (String(formData.get("website") ?? "").trim() !== "") return { ok: true };
  const parsed = InquiryInput.safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    await submitInquiry(parsed.data, hashIp(await visitorIp()));
    return { ok: true };
  } catch (e) {
    if (e instanceof RateLimitedError) return { error: e.message };
    console.error(e);
    return { error: "Sorry, something went wrong. Please try again or message us on Facebook." };
  }
}

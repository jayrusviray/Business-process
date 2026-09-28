import "server-only";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { withSystemTx } from "@/db/client";
import { appSettings, applicationTypes, publicSubmissions } from "@/db/schema";
import type { ContactMethod } from "@/lib/crm";
import { createApplication, findOrCreateClient } from "../applications/service";
import { notifyUsers, recordInquiry } from "../crm/leads";
import { RateLimitedError } from "./inquiry";

export type PublicApplication = {
  typeKey: string;
  name: string;
  mobile: string;
  email: string | null;
  address: string;
  preferredContact: ContactMethod;
  message: string;
};

/** Active application types offered on the public /apply form (cached with the website content). */
export const publicApplicationTypes = unstable_cache(loadPublicApplicationTypes, ["public-application-types-v1"], { tags: ["site"], revalidate: 3600 });

export async function loadPublicApplicationTypes(): Promise<{ key: string; label: string; description: string }[]> {
  return withSystemTx("public:apply", (tx) =>
    tx
      .select({ key: applicationTypes.key, label: applicationTypes.label, description: applicationTypes.description })
      .from(applicationTypes)
      .where(and(eq(applicationTypes.active, true), eq(applicationTypes.publicForm, true)))
      .orderBy(applicationTypes.sort),
  );
}

/**
 * Public application form (spec 4.9): a CRM lead (or a timeline entry on the
 * person's open lead) plus a draft application at the first status, for staff
 * to follow up. Shares the website's per-visitor rate limit.
 */
export async function submitPublicApplication(input: PublicApplication, ipHash: string): Promise<{ applicationId: string; appNo: string }> {
  return withSystemTx("public:apply", async (tx) => {
    const [type] = await tx
      .select()
      .from(applicationTypes)
      .where(and(eq(applicationTypes.key, input.typeKey), eq(applicationTypes.active, true), eq(applicationTypes.publicForm, true)));
    if (!type) throw new Error("unknown application type");
    const [limit] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "crm.inquiry_rate_limit_per_hour"));
    const max = typeof limit?.value === "number" ? limit.value : 5;
    const [recent] = await tx
      .select({ n: count() })
      .from(publicSubmissions)
      .where(and(eq(publicSubmissions.ipHash, ipHash), gt(publicSubmissions.createdAt, new Date(Date.now() - 3600_000))));
    if ((recent?.n ?? 0) >= max) throw new RateLimitedError();

    const lead = await recordInquiry(tx, {
      name: input.name,
      mobile: input.mobile,
      email: input.email,
      source: "landing_page",
      interest: type.serviceLine,
      location: input.address,
      preferredContact: input.preferredContact,
      message: [`Application form: ${type.label}`, input.message].filter(Boolean).join("\n"),
      consentAt: new Date(),
    });
    const client = await findOrCreateClient(tx, { name: input.name, mobile: input.mobile, email: input.email, address: input.address, leadId: lead.leadId });
    const app = await createApplication(tx, { typeKey: type.key, clientId: client.id, leadId: lead.leadId, source: "public", notes: input.message });
    await tx.insert(publicSubmissions).values({ kind: "application", ipHash, leadId: lead.leadId });
    const recipients = await tx.execute<{ id: string }>(sql`SELECT id FROM app.user_ids_with_roles('owner_admin', 'documentation') AS id`);
    await notifyUsers(
      tx,
      recipients.map((r) => r.id),
      { title: `New online application ${app.appNo}: ${input.name}`, body: type.label, link: `/app/applications/${app.id}` },
    );
    return { applicationId: app.id, appNo: app.appNo };
  });
}

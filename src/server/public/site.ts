import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { withSystemTx } from "@/db/client";
import { appSettings, siteBlocks } from "@/db/schema";
import type { ServiceLine } from "@/lib/crm";

export type SiteBlock = { id: string; title: string; body: string; serviceLine: ServiceLine | null };

export type SiteContent = {
  hero: SiteBlock | null;
  services: SiteBlock[];
  audiences: SiteBlock[];
  steps: SiteBlock[];
  requirements: SiteBlock[];
  programs: SiteBlock[];
  faqs: SiteBlock[];
  school: SiteBlock[];
  privacy: SiteBlock | null;
  facebookUrl: string;
  company: { name: string; address: string; phone: string; email: string };
};

export const SITE_CACHE_TAG = "site";
const FALLBACK_FB = "https://www.facebook.com/profile.php?id=61561492040341";

/** Public website content (read as the system: anonymous visitors have no DB access). */
export async function loadSiteContent(): Promise<SiteContent> {
  return withSystemTx("public:site", async (tx) => {
    const blocks = await tx
      .select({ id: siteBlocks.id, section: siteBlocks.section, title: siteBlocks.title, body: siteBlocks.body, serviceLine: siteBlocks.serviceLine })
      .from(siteBlocks)
      .where(eq(siteBlocks.active, true))
      .orderBy(asc(siteBlocks.section), asc(siteBlocks.sort), asc(siteBlocks.title));
    const settings = await tx
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(and(inArray(appSettings.key, ["company.profile", "site.facebook_url"])));
    const get = (k: string) => settings.find((s) => s.key === k)?.value;
    const of = (section: string) => blocks.filter((b) => b.section === section).map(({ id, title, body, serviceLine }) => ({ id, title, body, serviceLine }));
    const company = (get("company.profile") ?? {}) as Partial<SiteContent["company"]>;
    const fb = get("site.facebook_url");
    return {
      hero: of("hero")[0] ?? null,
      services: of("service"),
      audiences: of("audience"),
      steps: of("step"),
      requirements: of("requirement"),
      programs: of("program"),
      faqs: of("faq"),
      school: of("school"),
      privacy: of("privacy")[0] ?? null,
      facebookUrl: typeof fb === "string" && fb ? fb : FALLBACK_FB,
      company: { name: company.name || "TransRev", address: company.address ?? "", phone: company.phone ?? "", email: company.email ?? "" },
    };
  });
}

/** Cached for an hour; the website editor refreshes it immediately (tag "site"). */
export const getSiteContent = unstable_cache(loadSiteContent, ["site-content-v1"], { tags: [SITE_CACHE_TAG], revalidate: 3600 });

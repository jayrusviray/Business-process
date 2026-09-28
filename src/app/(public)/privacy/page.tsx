import type { Metadata } from "next";
import { getSiteContent } from "@/server/public/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy notice", description: "How TransRev handles your personal information (RA 10173)." };

export default async function PrivacyPage() {
  const site = await getSiteContent();
  const notice = site.privacy ?? { title: "Privacy notice", body: "" };
  return (
    <article className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-3xl font-bold tracking-tight">{notice.title}</h1>
      <div className="mt-6 whitespace-pre-line leading-relaxed">{notice.body}</div>
      <h2 className="mt-10 text-xl font-semibold">Contact</h2>
      <p className="mt-2 text-muted-foreground">
        {site.company.name}
        {site.company.email ? ` · ${site.company.email}` : ""}
        {site.company.phone ? ` · ${site.company.phone}` : ""}
        {site.company.address ? ` · ${site.company.address}` : ""}
      </p>
    </article>
  );
}

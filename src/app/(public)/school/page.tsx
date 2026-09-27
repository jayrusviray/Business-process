import type { Metadata } from "next";
import { getSiteContent } from "@/server/public/site";
import { InquiryForm } from "../inquiry-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Driver school",
  description: "TransRev driver school for TNVS drivers. Inquire to be notified when classes open.",
};

/** Placeholder school page (owner: details not available yet). Content is edited under Growth → Website. */
export default async function SchoolPage() {
  const site = await getSiteContent();
  const blocks = site.school.length ? site.school : [{ id: "x", title: "TransRev driver school", body: "Coming soon.", serviceLine: null }];
  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
      {blocks.map((b, i) =>
        i === 0 ? (
          <div key={b.id}>
            <h1 className="text-3xl font-bold tracking-tight">{b.title}</h1>
            <p className="mt-3 whitespace-pre-line text-muted-foreground">{b.body}</p>
          </div>
        ) : (
          <div key={b.id} className="mt-8">
            <h2 className="text-xl font-semibold">{b.title}</h2>
            <p className="mt-2 whitespace-pre-line text-muted-foreground">{b.body}</p>
          </div>
        ),
      )}
      <h2 className="mt-10 text-xl font-semibold">Get notified</h2>
      <div className="relative mt-4">
        <InquiryForm defaultInterest="school" />
      </div>
    </section>
  );
}

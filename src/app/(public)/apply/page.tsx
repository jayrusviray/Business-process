import type { Metadata } from "next";
import { publicApplicationTypes } from "@/server/public/apply";
import { ApplyForm } from "./apply-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Apply online",
  description: "Apply online for LTFRB PA/CPC processing, platform activation, or TransRev's boundary and rent-to-own vehicle programs.",
};

/** Public application form (spec 4.9): creates a draft application and a CRM lead. */
export default async function ApplyPage({ searchParams }: PageProps<"/apply">) {
  const types = await publicApplicationTypes();
  const { type } = await searchParams;
  const defaultType = typeof type === "string" && types.some((t) => t.key === type) ? type : undefined;
  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-3xl font-bold tracking-tight">Apply online</h1>
      <p className="mt-3 text-muted-foreground">
        Start your application here. We&apos;ll call or message you with the documents to prepare. No need to upload anything yet.
      </p>
      <div className="mt-6">
        <ApplyForm types={types} defaultType={defaultType} />
      </div>
    </section>
  );
}

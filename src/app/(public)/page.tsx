import { BadgeCheck, Building2, Car, FileCheck2, Handshake, Landmark, Smartphone, Store, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SERVICE_LINES, type ServiceLine } from "@/lib/crm";
import { getSiteContent } from "@/server/public/site";
import { InquiryForm } from "./inquiry-form";

export const dynamic = "force-dynamic";

const SERVICE_ICON: Partial<Record<ServiceLine, LucideIcon>> = {
  franchise: FileCheck2,
  activation: Smartphone,
  vehicle_program: Car,
  fleet: Handshake,
  investment: Landmark,
};
const AUDIENCE_ICONS: LucideIcon[] = [Users, Building2, Store, Landmark];

/** Public landing page (spec §7). Copy is edited under Growth → Website. */
export default async function LandingPage({ searchParams }: PageProps<"/">) {
  const site = await getSiteContent();
  const { interest } = await searchParams;
  const defaultInterest = typeof interest === "string" && (SERVICE_LINES as readonly string[]).includes(interest) ? (interest as ServiceLine) : undefined;
  const hero = site.hero ?? { title: "Hassle-free TNVS franchise, activation and fleet services", body: "" };
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: site.company.name,
    description: hero.body || hero.title,
    ...(site.company.phone ? { telephone: site.company.phone } : {}),
    ...(site.company.address ? { address: site.company.address } : {}),
    sameAs: [site.facebookUrl],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />

      {/* 1. Hero */}
      <section className="bg-brand-ink text-brand-ink-foreground">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium">
            <BadgeCheck className="size-4 text-brand-accent" aria-hidden /> TNVS services in the Philippines
          </p>
          <h1 className="max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">{hero.title}</h1>
          {hero.body ? <p className="mt-4 max-w-2xl text-base opacity-90 sm:text-lg">{hero.body}</p> : null}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href="#inquire" className="inline-flex h-12 items-center justify-center rounded-md bg-brand-accent px-6 text-base font-semibold text-brand-accent-foreground hover:opacity-90">
              Inquire now
            </a>
            <a
              href={site.facebookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center rounded-md border border-white/40 px-6 text-base font-medium hover:bg-white/10"
            >
              Message us on Facebook
            </a>
          </div>
        </div>
      </section>

      {/* 2. Services */}
      {site.services.length ? (
        <section id="services" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-14">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Our services</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {site.services.map((s) => {
              const Icon = (s.serviceLine && SERVICE_ICON[s.serviceLine]) || BadgeCheck;
              return (
                <article key={s.id} className="flex flex-col rounded-xl border bg-card p-5">
                  <Icon className="size-8 text-primary" aria-hidden />
                  <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
                  <p className="mt-2 flex-1 text-sm text-muted-foreground">{s.body}</p>
                  {s.serviceLine ? (
                    <a href={`?interest=${s.serviceLine}#inquire`} className="mt-4 text-sm font-medium text-primary underline-offset-2 hover:underline">
                      Ask about this →
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 3. Who we serve */}
      {site.audiences.length ? (
        <section className="bg-muted/60">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Who we serve</h2>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {site.audiences.map((a, i) => {
                const Icon = AUDIENCE_ICONS[i % AUDIENCE_ICONS.length];
                return (
                  <li key={a.id} className="rounded-xl bg-card p-5 shadow-sm">
                    <Icon className="size-6 text-primary" aria-hidden />
                    <p className="mt-2 font-semibold">{a.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{a.body}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

      {/* 4. How it works */}
      {site.steps.length ? (
        <section id="how" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-14">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">How it works</h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {site.steps.map((s, i) => (
              <li key={s.id} className="rounded-xl border p-5">
                <span className="flex size-9 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground" aria-hidden>
                  {i + 1}
                </span>
                <p className="mt-3 font-semibold">{s.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* 5. Requirements */}
      {site.requirements.length ? (
        <section id="requirements" className="bg-muted/60 scroll-mt-16">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Requirements checklist</h2>
            <p className="mt-2 text-muted-foreground">What to prepare. We&apos;ll confirm the full list for your case after your inquiry.</p>
            <div className="mt-6 grid gap-3 lg:grid-cols-3">
              {site.requirements.map((r) => (
                <details key={r.id} className="group rounded-xl bg-card p-5 shadow-sm" open>
                  <summary className="cursor-pointer list-none font-semibold">
                    {r.title}
                    <span className="float-right text-muted-foreground group-open:rotate-180" aria-hidden>
                      ▾
                    </span>
                  </summary>
                  <ul className="mt-3 flex flex-col gap-2 text-sm">
                    {r.body
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean)
                      .map((l) => (
                        <li key={l} className="flex gap-2">
                          <BadgeCheck className="size-4 shrink-0 translate-y-0.5 text-success" aria-hidden />
                          {l}
                        </li>
                      ))}
                  </ul>
                </details>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* 6. Vehicle programs */}
      {site.programs.length ? (
        <section id="programs" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-14">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Vehicle programs</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {site.programs.map((p) => (
              <article key={p.id} className="rounded-xl border p-5">
                <h3 className="text-lg font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{p.body}</p>
              </article>
            ))}
          </div>
          <a href="?interest=vehicle_program#inquire" className="mt-6 inline-flex h-12 items-center rounded-md bg-primary px-6 text-base font-medium text-primary-foreground hover:bg-primary/90">
            Ask for current units
          </a>
        </section>
      ) : null}

      {/* 7. FAQs */}
      {site.faqs.length ? (
        <section id="faqs" className="bg-muted/60 scroll-mt-16">
          <div className="mx-auto max-w-3xl px-4 py-14">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Frequently asked questions</h2>
            <div className="mt-6 flex flex-col gap-3">
              {site.faqs.map((f) => (
                <details key={f.id} className="rounded-xl bg-card p-4 shadow-sm">
                  <summary className="cursor-pointer font-medium">{f.title}</summary>
                  <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{f.body}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* 8. Inquiry form */}
      <section id="inquire" className="mx-auto max-w-3xl scroll-mt-16 px-4 py-14">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Send us an inquiry</h2>
        <p className="mt-2 text-muted-foreground">
          Tell us what you need and we&apos;ll get back to you within the day. You can also{" "}
          <a href={site.facebookUrl} target="_blank" rel="noopener noreferrer" className="underline">
            message us on Facebook
          </a>
          .
        </p>
        <div className="relative mt-6">
          <InquiryForm key={defaultInterest ?? "none"} defaultInterest={defaultInterest} />
        </div>
      </section>
    </>
  );
}

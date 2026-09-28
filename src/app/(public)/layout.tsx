import type { Metadata } from "next";
import Link from "next/link";
import { siteUrl } from "@/lib/site-url";
import { getSiteContent } from "@/server/public/site";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: "TransRev — TNVS franchise, activation & vehicle programs", template: "%s · TransRev" },
  description:
    "Hassle-free LTFRB PA/CPC franchise processing, ride-hailing platform activation, and boundary / rent-to-own vehicle programs for TNVS drivers and operators in the Philippines.",
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_PH",
    siteName: "TransRev",
    title: "TransRev — TNVS franchise, activation & vehicle programs",
    description: "LTFRB PA/CPC processing, platform activation and vehicle programs for TNVS drivers and operators.",
  },
  twitter: { card: "summary_large_image" },
};

/** Public website shell (landing page, school page, privacy notice, application form). */
export default async function PublicLayout({ children }: LayoutProps<"/">) {
  const site = await getSiteContent();
  const year = new Date().getFullYear();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:p-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <Link href="/" className="text-lg font-bold tracking-tight">
            TransRev
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1 text-sm sm:gap-4">
            <Link href="/#services" className="hidden rounded-md px-2 py-2 hover:bg-muted sm:inline">
              Services
            </Link>
            <Link href="/#requirements" className="hidden rounded-md px-2 py-2 hover:bg-muted md:inline">
              Requirements
            </Link>
            <Link href="/#faqs" className="hidden rounded-md px-2 py-2 hover:bg-muted md:inline">
              FAQs
            </Link>
            <Link href="/apply" className="rounded-md px-2 py-2 hover:bg-muted">
              Apply
            </Link>
            <Link href="/login" className="rounded-md px-2 py-2 text-muted-foreground hover:bg-muted">
              Log in
            </Link>
            <Link href="/#inquire" className="rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground hover:bg-primary/90">
              Inquire now
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="bg-brand-ink text-brand-ink-foreground">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 text-sm sm:grid-cols-3">
          <div>
            <p className="text-base font-semibold">{site.company.name}</p>
            <p className="mt-1 opacity-80">TNVS franchise documentation, platform activation and vehicle programs.</p>
          </div>
          {site.company.address || site.company.phone || site.company.email ? (
            <address className="not-italic opacity-90">
              {site.company.address ? <p>{site.company.address}</p> : null}
              {site.company.phone ? (
                <p>
                  <a href={`tel:${site.company.phone.replace(/[^\d+]/g, "")}`} className="underline-offset-2 hover:underline">
                    {site.company.phone}
                  </a>
                </p>
              ) : null}
              {site.company.email ? (
                <p>
                  <a href={`mailto:${site.company.email}`} className="underline-offset-2 hover:underline">
                    {site.company.email}
                  </a>
                </p>
              ) : null}
            </address>
          ) : null}
          <ul className="flex flex-col gap-1 opacity-90">
            <li>
              <a href={site.facebookUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                Facebook page
              </a>
            </li>
            <li>
              <Link href="/privacy" className="underline-offset-2 hover:underline">
                Privacy notice
              </Link>
            </li>
            <li>
              <Link href="/apply" className="underline-offset-2 hover:underline">
                Apply online
              </Link>
            </li>
            <li>
              <Link href="/school" className="underline-offset-2 hover:underline">
                Driver school
              </Link>
            </li>
          </ul>
        </div>
        <p className="border-t border-white/10 py-4 text-center text-xs opacity-70">
          © {year} {site.company.name}. All rights reserved.
        </p>
      </footer>
    </div>
  );
}

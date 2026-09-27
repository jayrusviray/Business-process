"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CURRENT_PHASE, type NavSection } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function StaffNav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-5 text-sm">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.title}</p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted",
                      active && "bg-muted font-medium",
                    )}
                  >
                    {item.label}
                    {item.phase > CURRENT_PHASE ? <span className="text-[10px] text-muted-foreground">P{item.phase}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function MobileNav({ sections }: { sections: NavSection[] }) {
  return (
    <details className="group lg:hidden">
      <summary className="cursor-pointer list-none rounded-md border px-3 py-1.5 text-sm">Menu</summary>
      <div className="absolute inset-x-0 top-14 z-20 max-h-[80dvh] overflow-y-auto border-b bg-background p-4 shadow-lg">
        <StaffNav
          sections={sections}
          onNavigate={() => document.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"))}
        />
      </div>
    </details>
  );
}

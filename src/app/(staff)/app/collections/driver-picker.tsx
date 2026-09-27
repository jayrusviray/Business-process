"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";

type Row = { id: string; name: string; plate_no: string | null; phone: string };

/** Mobile-friendly search list; tapping a driver opens the payment form for them. */
export function DriverPicker({ drivers, hrefBase }: { drivers: Row[]; hrefBase: string }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return drivers.slice(0, 50);
    return drivers
      .filter((d) => d.name.toLowerCase().includes(s) || d.plate_no?.toLowerCase().includes(s) || d.phone.includes(s))
      .slice(0, 50);
  }, [q, drivers]);
  return (
    <div className="flex flex-col gap-3">
      <Input autoFocus placeholder="Search name, plate or phone" value={q} onChange={(e) => setQ(e.target.value)} className="h-12" />
      <ul className="divide-y rounded-md border">
        {filtered.map((d) => (
          <li key={d.id}>
            <Link href={`${hrefBase}${d.id}`} className="flex items-center justify-between px-3 py-3 hover:bg-muted">
              <span className="font-medium">{d.name}</span>
              <span className="text-sm text-muted-foreground">{d.plate_no ?? d.phone}</span>
            </Link>
          </li>
        ))}
        {filtered.length === 0 ? <li className="px-3 py-3 text-sm text-muted-foreground">No match.</li> : null}
      </ul>
    </div>
  );
}

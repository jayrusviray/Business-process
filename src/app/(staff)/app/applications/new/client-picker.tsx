"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { Input, Select } from "@/components/ui/input";

/** Existing client or a new one (toggle), inside the new-application form. */
export function ClientPicker({ clients, defaultClientId }: { clients: { id: string; name: string; mobile: string }[]; defaultClientId?: string }) {
  const [mode, setMode] = useState<"existing" | "new">(defaultClientId || clients.length ? "existing" : "new");
  const [q, setQ] = useState("");
  const shown = q ? clients.filter((c) => `${c.name} ${c.mobile}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200) : clients.slice(0, 200);
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Client</legend>
      <input type="hidden" name="clientMode" value={mode} />
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} className="size-4" /> Existing client
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} className="size-4" /> New client
        </label>
      </div>
      {mode === "existing" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or mobile" aria-label="Search clients" />
          <Select name="clientId" defaultValue={defaultClientId ?? ""} required aria-label="Client">
            <option value="" disabled>
              Choose a client
            </option>
            {shown.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.mobile ? ` · ${c.mobile}` : ""}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name (person or company)" htmlFor="clientName">
            <Input id="clientName" name="clientName" required />
          </Field>
          <Field label="Type" htmlFor="clientKind">
            <Select id="clientKind" name="clientKind" defaultValue="person">
              <option value="person">Person</option>
              <option value="company">Company</option>
            </Select>
          </Field>
          <Field label="Mobile" htmlFor="mobile" hint="An existing client with the same mobile is reused.">
            <Input id="mobile" name="mobile" type="tel" inputMode="tel" placeholder="0917 123 4567" />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" />
          </Field>
          <Field label="Contact person (companies)" htmlFor="contactPerson">
            <Input id="contactPerson" name="contactPerson" />
          </Field>
          <Field label="Address" htmlFor="address">
            <Input id="address" name="address" />
          </Field>
        </div>
      )}
    </fieldset>
  );
}

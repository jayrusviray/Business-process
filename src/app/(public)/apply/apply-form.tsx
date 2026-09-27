"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { CONTACT_LABELS, CONTACT_METHODS } from "@/lib/crm";
import { submitApplicationAction, type ApplyState } from "../actions";

const field = "h-12 text-base";

/** Public application form. Documents are collected after we contact the applicant (no public uploads). */
export function ApplyForm({ types, defaultType }: { types: { key: string; label: string; description: string }[]; defaultType?: string }) {
  const [state, action, pending] = useActionState<ApplyState, FormData>(submitApplicationAction, {});
  if (state.ok) {
    return (
      <div role="status" className="rounded-xl border bg-card p-6 text-center">
        <p className="text-xl font-semibold">Salamat! We received your application.</p>
        {state.appNo ? <p className="mt-1 font-mono text-sm">Reference: {state.appNo}</p> : null}
        <p className="mt-2 text-muted-foreground">We&apos;ll contact you within the day with the list of documents to prepare.</p>
      </div>
    );
  }
  return (
    <form action={action} className="relative grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 sm:p-6">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="ap-type">What are you applying for?</Label>
        <Select id="ap-type" name="typeKey" defaultValue={defaultType ?? ""} required className={field}>
          <option value="" disabled>
            Choose one
          </option>
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ap-name">Full name (or company name)</Label>
        <Input id="ap-name" name="name" autoComplete="name" required className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ap-mobile">Mobile number</Label>
        <Input id="ap-mobile" name="mobile" type="tel" inputMode="tel" autoComplete="tel" placeholder="0917 123 4567" required className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ap-email">Email (optional)</Label>
        <Input id="ap-email" name="email" type="email" autoComplete="email" className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ap-contact">How should we contact you?</Label>
        <Select id="ap-contact" name="preferredContact" defaultValue="call" className={field}>
          {CONTACT_METHODS.map((c) => (
            <option key={c} value={c}>
              {CONTACT_LABELS[c]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="ap-address">Address</Label>
        <Input id="ap-address" name="address" autoComplete="street-address" className={field} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="ap-message">Anything we should know? (vehicle, plate number, platform…)</Label>
        <textarea
          id="ap-message"
          name="message"
          rows={4}
          maxLength={1000}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="ap-website">Website</label>
        <input id="ap-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <label className="flex items-start gap-3 text-sm sm:col-span-2">
        <input type="checkbox" name="consent" required className="mt-0.5 size-5 shrink-0" />
        <span>
          I agree to TransRev collecting and using my information to process this application, as explained in the{" "}
          <Link href="/privacy" className="underline" target="_blank">
            privacy notice
          </Link>{" "}
          (Data Privacy Act of 2012, RA 10173).
        </span>
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className="h-12 text-base sm:col-span-2">
        {pending ? "Sending…" : "Submit application"}
      </Button>
    </form>
  );
}

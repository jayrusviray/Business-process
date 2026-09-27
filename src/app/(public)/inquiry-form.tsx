"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { CONTACT_LABELS, CONTACT_METHODS, SERVICE_LINE_LABELS, SERVICE_LINES, type ServiceLine } from "@/lib/crm";
import { submitInquiryAction, type InquiryState } from "./actions";

const field = "h-12 text-base";

/** Website inquiry form. Mobile-first: big inputs, text-base so iOS doesn't zoom. */
export function InquiryForm({ defaultInterest, services = SERVICE_LINES }: { defaultInterest?: ServiceLine; services?: readonly ServiceLine[] }) {
  const [state, action, pending] = useActionState<InquiryState, FormData>(submitInquiryAction, {});
  if (state.ok) {
    return (
      <div role="status" className="rounded-xl border bg-card p-6 text-center">
        <p className="text-xl font-semibold">Salamat! We got your inquiry.</p>
        <p className="mt-2 text-muted-foreground">Our team will get in touch with you within the day.</p>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 sm:p-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inq-name">Full name</Label>
        <Input id="inq-name" name="name" autoComplete="name" required className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inq-mobile">Mobile number</Label>
        <Input id="inq-mobile" name="mobile" type="tel" inputMode="tel" autoComplete="tel" placeholder="0917 123 4567" required className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inq-email">Email (optional)</Label>
        <Input id="inq-email" name="email" type="email" autoComplete="email" className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inq-location">City / province</Label>
        <Input id="inq-location" name="location" autoComplete="address-level2" className={field} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inq-interest">Service you&apos;re interested in</Label>
        <Select id="inq-interest" name="interest" defaultValue={defaultInterest ?? ""} required className={field}>
          <option value="" disabled>
            Choose one
          </option>
          {services.map((s) => (
            <option key={s} value={s}>
              {SERVICE_LINE_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inq-contact">How should we contact you?</Label>
        <Select id="inq-contact" name="preferredContact" defaultValue="call" className={field}>
          {CONTACT_METHODS.map((c) => (
            <option key={c} value={c}>
              {CONTACT_LABELS[c]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="inq-message">Message</Label>
        <textarea
          id="inq-message"
          name="message"
          rows={4}
          maxLength={1000}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Tell us a bit about what you need"
        />
      </div>
      {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="inq-website">Website</label>
        <input id="inq-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <label className="flex items-start gap-3 text-sm sm:col-span-2">
        <input type="checkbox" name="consent" required className="mt-0.5 size-5 shrink-0" />
        <span>
          I agree to TransRev collecting and using my information to answer this inquiry, as explained in the{" "}
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
        {pending ? "Sending…" : "Send inquiry"}
      </Button>
    </form>
  );
}

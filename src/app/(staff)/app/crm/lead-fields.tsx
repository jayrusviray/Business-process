import { Field } from "@/components/field";
import { Input, Select } from "@/components/ui/input";
import { CONTACT_LABELS, CONTACT_METHODS, LEAD_SOURCES, SERVICE_LINE_LABELS, SERVICE_LINES, SOURCE_LABELS } from "@/lib/crm";

type LeadValues = {
  name?: string;
  mobile?: string;
  email?: string | null;
  fbName?: string;
  source?: string;
  interest?: string;
  location?: string;
  preferredContact?: string | null;
  referrerName?: string;
  referrerPhone?: string;
  notes?: string;
};

/** Shared lead fields for the new-lead and edit forms. */
export function LeadFields({ lead = {}, withMessage = false }: { lead?: LeadValues; withMessage?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor="name">
        <Input id="name" name="name" defaultValue={lead.name} required />
      </Field>
      <Field label="Mobile" htmlFor="mobile" hint="Used to spot duplicates.">
        <Input id="mobile" name="mobile" type="tel" inputMode="tel" defaultValue={lead.mobile} placeholder="0917 123 4567" />
      </Field>
      <Field label="Facebook / Messenger name" htmlFor="fbName">
        <Input id="fbName" name="fbName" defaultValue={lead.fbName} />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" defaultValue={lead.email ?? ""} />
      </Field>
      <Field label="Source" htmlFor="source">
        <Select id="source" name="source" defaultValue={lead.source ?? "messenger"}>
          {LEAD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Interested in" htmlFor="interest">
        <Select id="interest" name="interest" defaultValue={lead.interest ?? "franchise"}>
          {SERVICE_LINES.map((s) => (
            <option key={s} value={s}>
              {SERVICE_LINE_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Location" htmlFor="location">
        <Input id="location" name="location" defaultValue={lead.location} />
      </Field>
      <Field label="Preferred contact" htmlFor="preferredContact">
        <Select id="preferredContact" name="preferredContact" defaultValue={lead.preferredContact ?? ""}>
          <option value="">—</option>
          {CONTACT_METHODS.map((c) => (
            <option key={c} value={c}>
              {CONTACT_LABELS[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Referred by" htmlFor="referrerName" hint="For referral commissions.">
        <Input id="referrerName" name="referrerName" defaultValue={lead.referrerName} />
      </Field>
      <Field label="Referrer's mobile" htmlFor="referrerPhone">
        <Input id="referrerPhone" name="referrerPhone" defaultValue={lead.referrerPhone} />
      </Field>
      {withMessage ? (
        <Field label="What they asked" htmlFor="message" className="sm:col-span-2">
          <textarea id="message" name="message" rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm" />
        </Field>
      ) : null}
      <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
        <textarea id="notes" name="notes" rows={2} defaultValue={lead.notes} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm" />
      </Field>
    </div>
  );
}

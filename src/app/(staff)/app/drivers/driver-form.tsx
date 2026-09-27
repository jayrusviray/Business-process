import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import type { ActionState } from "@/server/action";

type Driver = {
  id?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string | null;
  address?: string;
  birthdate?: string | null;
  licenseNo?: string | null;
  licenseExpiry?: string | null;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  status?: string;
  preferredLanguage?: string;
  notes?: string;
};

export const DRIVER_STATUSES = ["applicant", "active", "suspended", "completed", "terminated"] as const;

export const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "default"> = {
  active: "success",
  applicant: "default",
  suspended: "warning",
  completed: "muted",
  terminated: "destructive",
};

export function DriverForm({ action, driver = {}, submitLabel }: { action: (s: ActionState, f: FormData) => Promise<ActionState>; driver?: Driver; submitLabel: string }) {
  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-2">
      {driver.id ? <input type="hidden" name="id" value={driver.id} /> : null}
      <Field label="First name" htmlFor="firstName">
        <Input id="firstName" name="firstName" defaultValue={driver.firstName} required />
      </Field>
      <Field label="Last name" htmlFor="lastName">
        <Input id="lastName" name="lastName" defaultValue={driver.lastName} required />
      </Field>
      <Field label="Mobile number" htmlFor="phone">
        <Input id="phone" name="phone" type="tel" inputMode="tel" placeholder="0917 123 4567" defaultValue={driver.phone} required />
      </Field>
      <Field label="Email (optional)" htmlFor="email">
        <Input id="email" name="email" type="email" defaultValue={driver.email ?? ""} />
      </Field>
      <Field label="Address" htmlFor="address" className="sm:col-span-2">
        <Input id="address" name="address" defaultValue={driver.address} />
      </Field>
      <Field label="Birthdate" htmlFor="birthdate">
        <Input id="birthdate" name="birthdate" type="date" defaultValue={driver.birthdate ?? ""} />
      </Field>
      <Field label="Status" htmlFor="status">
        <Select id="status" name="status" defaultValue={driver.status ?? "applicant"}>
          {DRIVER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Reminder language" htmlFor="preferredLanguage">
        <Select id="preferredLanguage" name="preferredLanguage" defaultValue={driver.preferredLanguage ?? "taglish"}>
          <option value="taglish">Taglish</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <Field label="Driver's license no." htmlFor="licenseNo">
        <Input id="licenseNo" name="licenseNo" defaultValue={driver.licenseNo ?? ""} />
      </Field>
      <Field label="License expiry" htmlFor="licenseExpiry">
        <Input id="licenseExpiry" name="licenseExpiry" type="date" defaultValue={driver.licenseExpiry ?? ""} />
      </Field>
      <Field label="Emergency contact" htmlFor="emergencyContactName">
        <Input id="emergencyContactName" name="emergencyContactName" defaultValue={driver.emergencyContactName} />
      </Field>
      <Field label="Emergency contact number" htmlFor="emergencyContactPhone">
        <Input id="emergencyContactPhone" name="emergencyContactPhone" type="tel" defaultValue={driver.emergencyContactPhone} />
      </Field>
      <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
        <Textarea id="notes" name="notes" defaultValue={driver.notes} className="font-sans" />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </ActionForm>
  );
}

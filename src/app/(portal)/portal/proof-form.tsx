"use client";

import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { submitProofAction } from "./actions";

/** Mobile form: send a payment screenshot for verification. Large inputs (text-base) so iOS doesn't zoom. */
export function ProofForm({ today }: { today: string }) {
  return (
    <ActionForm action={submitProofAction} className="flex flex-col gap-3">
      <Field label="Screenshot of your payment" htmlFor="proof">
        <Input id="proof" name="proof" type="file" accept="image/*,application/pdf" required className="h-12 py-2.5" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount sent (₱)" htmlFor="amount">
          <Input id="amount" name="amount" inputMode="decimal" placeholder="0.00" required className="h-12 text-lg" />
        </Field>
        <Field label="Paid via" htmlFor="method">
          <Select id="method" name="method" defaultValue="gcash" className="h-12">
            <option value="gcash">GCash</option>
            <option value="maya">Maya</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Reference no." htmlFor="referenceNo">
          <Input id="referenceNo" name="referenceNo" required className="h-12" />
        </Field>
        <Field label="Date paid" htmlFor="paidOn">
          <Input id="paidOn" name="paidOn" type="date" defaultValue={today} max={today} required className="h-12" />
        </Field>
      </div>
      <Field label="Note (optional)" htmlFor="note">
        <Input id="note" name="note" maxLength={300} className="h-12" placeholder="e.g. boundary for Mon–Wed" />
      </Field>
      <Button type="submit" size="lg" className="h-12">Send proof</Button>
    </ActionForm>
  );
}

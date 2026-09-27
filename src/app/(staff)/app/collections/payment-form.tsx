"use client";

import { useActionState, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { formatPeso, parsePeso } from "@/lib/money";
import type { ActionState } from "@/server/action";

type Account = { id: string; label: string; balance: string; oldestUnpaid: string | null };
type Collector = { id: string; name: string };

/**
 * Mobile-first payment form. The collector decides how much goes to each account
 * (owner rule). Ids are generated at page render, so a double submit posts once.
 */
export function PaymentForm({
  action,
  driverId,
  paymentId,
  clientRequestId,
  accounts,
  collectors,
  defaultCollectorId,
  today,
}: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  driverId: string;
  paymentId: string;
  clientRequestId: string;
  accounts: Account[];
  collectors: Collector[];
  defaultCollectorId: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [method, setMethod] = useState("cash");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  let total = BigInt(0);
  let totalOk = true;
  for (const v of Object.values(amounts)) {
    if (!v.trim()) continue;
    try {
      total += parsePeso(v);
    } catch {
      totalOk = false;
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="driverId" value={driverId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="clientRequestId" value={clientRequestId} />

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">Amount per account</legend>
        {accounts.map((a) => (
          <div key={a.id} className="rounded-md border p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="font-medium">{a.label}</span>
              <span className="text-xs text-muted-foreground">
                Balance <span className="money">{formatPeso(BigInt(a.balance))}</span>
                {a.oldestUnpaid ? ` · unpaid since ${a.oldestUnpaid}` : ""}
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                name={`amount:${a.id}`}
                inputMode="decimal"
                placeholder="0.00"
                className="h-12 text-lg"
                value={amounts[a.id] ?? ""}
                onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))}
                aria-label={`${a.label} amount`}
              />
              {BigInt(a.balance) > BigInt(0) ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-12"
                  onClick={() => setAmounts((m) => ({ ...m, [a.id]: formatPeso(BigInt(a.balance), { symbol: false }) }))}
                >
                  Full
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Method" htmlFor="method">
          <Select id="method" name="method" value={method} onChange={(e) => setMethod(e.target.value)} className="h-12">
            <option value="cash">Cash</option>
            <option value="gcash">GCash</option>
            <option value="maya">Maya</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Date" htmlFor="businessDate">
          <Input id="businessDate" name="businessDate" type="date" defaultValue={today} max={today} className="h-12" required />
        </Field>
        {method !== "cash" ? (
          <>
            <Field label="Reference no." htmlFor="referenceNo">
              <Input id="referenceNo" name="referenceNo" required className="h-12" />
            </Field>
            {method === "bank_transfer" ? (
              <Field label="Bank" htmlFor="bankName">
                <Input id="bankName" name="bankName" defaultValue="BDO" className="h-12" />
              </Field>
            ) : null}
          </>
        ) : null}
        <Field label="Received by" htmlFor="collectorId" className="col-span-2">
          <Select id="collectorId" name="collectorId" defaultValue={defaultCollectorId} className="h-12">
            {collectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Receipt / proof photo (optional)" htmlFor="receipt" className="col-span-2">
          <Input id="receipt" name="receipt" type="file" accept="image/*,application/pdf" capture="environment" />
        </Field>
        <Field label="Notes" htmlFor="notes" className="col-span-2">
          <Input id="notes" name="notes" />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending || !totalOk || total <= BigInt(0)} className="h-14 text-lg">
        {pending ? "Saving…" : `Record ${totalOk ? formatPeso(total) : "payment"}`}
      </Button>
    </form>
  );
}

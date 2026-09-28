import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { CASH_ACCOUNT_KINDS, ROUTABLE_METHODS } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { getSetting } from "@/server/office/settings";
import { listCashAccounts } from "@/server/queries/cashbook";
import { saveAccountAction, saveRoutingAction } from "../actions";

export const metadata = { title: "Cash accounts" };

const METHOD_LABEL: Record<string, string> = { cash: "Cash", gcash: "GCash", maya: "Maya", bank_transfer: "Bank transfer", other: "Other" };
const ROUTING_LABEL: Record<string, string> = {
  payroll: "Payroll (and salary deductions of cash advances)",
  loan_payment: "Vehicle loan payments",
  investor_payout: "Investor payouts",
  commission_payout: "Commission payouts",
  commission_received: "Commissions received",
  cash_advance: "Cash advances given and returned",
  driver_bonus: "Quota bonuses paid in cash",
  check: "Expenses paid by check",
};

function AccountFields({ a, idp }: { a?: Awaited<ReturnType<typeof listCashAccounts>>[number]; idp: string }) {
  return (
    <>
      {a ? <input type="hidden" name="id" value={a.id} /> : null}
      <Field label="Name" htmlFor={`${idp}-name`}><Input id={`${idp}-name`} name="name" defaultValue={a?.name} required /></Field>
      <Field label="Kind" htmlFor={`${idp}-kind`}>
        <Select id={`${idp}-kind`} name="kind" defaultValue={a?.kind ?? "bank"}>{CASH_ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select>
      </Field>
      <Field label="Receives payments made by" htmlFor={`${idp}-method`} hint="One account per method; choosing it here takes it from another account.">
        <Select id={`${idp}-method`} name="paymentMethod" defaultValue={a?.paymentMethod ?? ""}>
          <option value="">— (manual entries only)</option>
          {ROUTABLE_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </Select>
      </Field>
      <Field label="Order" htmlFor={`${idp}-sort`}><Input id={`${idp}-sort`} name="sort" inputMode="numeric" defaultValue={a?.sort ?? 100} /></Field>
      <Field label="Notes" htmlFor={`${idp}-notes`} className="sm:col-span-2"><Input id={`${idp}-notes`} name="notes" defaultValue={a?.notes} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={a?.active ?? true} className="size-4" /> Active</label>
    </>
  );
}

export default async function CashAccountsPage() {
  const session = await requireRole(["owner_admin", "finance"]);
  const isOwner = hasAnyRole(session.roles, ["owner_admin"]);
  const { accounts, routing } = await withUserTx(session.claims, async (tx) => ({
    accounts: await listCashAccounts(tx),
    routing: await getSetting(tx, "cashbook.default_routing"),
  }));
  const byMethod = new Map(accounts.filter((a) => a.paymentMethod).map((a) => [a.paymentMethod as string, a.name]));

  return (
    <>
      <PageHeader
        title="Cash accounts"
        description="Where money is kept, and which account each kind of record lands in by default."
        actions={<Button asChild variant="outline"><Link href="/app/cashbook">Back to cash book</Link></Button>}
      />
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {accounts.map((a) => (
          <Card key={a.id}>
            <CardHeader><CardTitle>{a.name}{a.active ? "" : " (inactive)"}</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={saveAccountAction} className="grid gap-3 sm:grid-cols-2">
                <AccountFields a={a} idp={a.id} />
                <Button type="submit" variant="outline" className="justify-self-start">Save</Button>
              </ActionForm>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader><CardTitle>Add an account</CardTitle><CardDescription>Opening balance: record it in the cash book as an &ldquo;Opening balance&rdquo; entry dated the day you start.</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={saveAccountAction} className="grid gap-3 sm:grid-cols-2">
              <AccountFields idp="new" />
              <Button type="submit" className="justify-self-start">Add account</Button>
            </ActionForm>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Records without a payment method</CardTitle>
          <CardDescription>
            Driver payments, fee payments and expenses carry a payment method and go to that method&apos;s account. These records don&apos;t, so
            they go to the account of the method chosen here. &ldquo;Other&rdquo; means not decided yet. A single record can still be moved from the cash book.
            {isOwner ? "" : " Only the owner/admin can change this."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveRoutingAction} className="grid gap-3 sm:grid-cols-2">
            {Object.entries(ROUTING_LABEL).map(([key, label]) => (
              <Field key={key} label={label} htmlFor={`route-${key}`} hint={`Now: ${byMethod.get(routing[key as keyof typeof routing]) ?? "Other"}`}>
                <Select id={`route-${key}`} name={key} defaultValue={routing[key as keyof typeof routing]} disabled={!isOwner}>
                  {ROUTABLE_METHODS.map((m) => <option key={m} value={m}>{byMethod.get(m) ? `${byMethod.get(m)} (${METHOD_LABEL[m]})` : METHOD_LABEL[m]}</option>)}
                </Select>
              </Field>
            ))}
            {isOwner ? <Button type="submit" className="justify-self-start">Save routing</Button> : null}
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}

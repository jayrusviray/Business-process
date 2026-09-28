import { and, asc, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import {
  applicationChecklistItems,
  applicationCommissions,
  applications,
  applicationStatuses,
  applicationStatusHistory,
  applicationTypes,
  clients,
  profiles,
  vehicles,
} from "@/db/schema";
import { checklistProgress } from "@/lib/applications";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { applicationMoney } from "@/server/applications/service";
import { listApplicationStaff } from "@/server/queries/staff";
import {
  addChecklistItemAction,
  addFeeAction,
  createDriverAction,
  recordFeePaymentAction,
  setStatusAction,
  updateApplicationAction,
  uploadChecklistAction,
  verifyChecklistAction,
  voidFeeAction,
  voidFeePaymentAction,
} from "../actions";

export const metadata = { title: "Application" };

const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
const KIND_VARIANT = { open: "default", approved: "success", completed: "success", on_hold: "warning", cancelled: "muted" } as const;

export default async function ApplicationPage({ params }: PageProps<"/app/applications/[id]">) {
  const session = await requireRole(["owner_admin", "operations", "sales", "documentation", "finance"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withUserTx(session.claims, async (tx) => {
    const [row] = await tx
      .select({ app: applications, client: clients, type: applicationTypes, status: applicationStatuses })
      .from(applications)
      .innerJoin(clients, eq(clients.id, applications.clientId))
      .innerJoin(applicationTypes, eq(applicationTypes.key, applications.typeKey))
      .innerJoin(applicationStatuses, eq(applicationStatuses.key, applications.statusKey))
      .where(eq(applications.id, id));
    if (!row) return null;
    const [items, history, statuses, money, staff, vehicleList, commission] = await Promise.all([
      tx
        .select({ i: applicationChecklistItems, verifier: profiles.fullName })
        .from(applicationChecklistItems)
        .leftJoin(profiles, eq(profiles.id, applicationChecklistItems.verifiedBy))
        .where(eq(applicationChecklistItems.applicationId, id))
        .orderBy(asc(applicationChecklistItems.sort), asc(applicationChecklistItems.createdAt)),
      tx
        .select({ h: applicationStatusHistory, by: profiles.fullName })
        .from(applicationStatusHistory)
        .leftJoin(profiles, eq(profiles.id, applicationStatusHistory.changedBy))
        .where(eq(applicationStatusHistory.applicationId, id))
        .orderBy(desc(applicationStatusHistory.changedAt)),
      tx.select().from(applicationStatuses).orderBy(asc(applicationStatuses.sort)),
      applicationMoney(tx, id),
      listApplicationStaff(tx),
      tx.select({ id: vehicles.id, plateNo: vehicles.plateNo }).from(vehicles).orderBy(asc(vehicles.plateNo)),
      tx
        .select()
        .from(applicationCommissions)
        .where(and(eq(applicationCommissions.applicationId, id), ne(applicationCommissions.status, "void"))),
    ]);
    return { ...row, items, history, statuses, money, staff, vehicleList, commission: commission[0] ?? null };
  });
  if (!data) notFound();
  const { app, client, type, status, items, history, statuses, money, staff, vehicleList, commission } = data;
  const progress = checklistProgress(items.map(({ i }) => ({ required: i.required, documentId: i.documentId, verifiedAt: i.verifiedAt })));
  const statusLabel = new Map(statuses.map((s) => [s.key, s.label]));
  const canWork = hasAnyRole(session.roles, ["owner_admin", "operations", "sales", "documentation"]);
  const canDocs = hasAnyRole(session.roles, ["owner_admin", "operations", "documentation"]);
  const canFee = hasAnyRole(session.roles, ["owner_admin", "operations", "documentation", "finance", "sales"]);
  const canPay = hasAnyRole(session.roles, ["owner_admin", "operations", "documentation", "finance"]);
  const canVoid = hasAnyRole(session.roles, ["owner_admin", "finance"]);
  const canMakeDriver = hasAnyRole(session.roles, ["owner_admin", "operations"]);
  const today = businessToday();

  return (
    <>
      <PageHeader
        title={`${app.appNo} · ${client.name}`}
        description={type.label}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={KIND_VARIANT[status.kind]}>{status.label}</Badge>
            {app.source === "public" ? <Badge variant="muted">online application</Badge> : null}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link href={`/app/clients/${client.id}`} className="underline">
          Client details
        </Link>
        {client.mobile ? (
          <a href={`tel:${client.mobile}`} className="underline">
            Call {client.mobile}
          </a>
        ) : null}
        {app.leadId ? (
          <Link href={`/app/crm/${app.leadId}`} className="underline">
            CRM lead
          </Link>
        ) : null}
        {app.driverId ? (
          <Link href={`/app/drivers/${app.driverId}`} className="underline">
            Driver profile
          </Link>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Document checklist</CardTitle>
              <CardDescription>
                {progress.verifiedRequired}/{progress.required} required documents verified
                {progress.complete ? " · complete" : ""}. {progress.submitted} of {progress.total} received.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {items.map(({ i, verifier }) => (
                <div key={i.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {i.label} {i.required ? null : <Badge variant="muted">optional</Badge>}
                    </span>
                    {i.verifiedAt ? (
                      <Badge variant="success">verified</Badge>
                    ) : i.documentId ? (
                      <Badge variant="warning">to verify</Badge>
                    ) : (
                      <Badge variant="muted">missing</Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {i.documentId ? (
                      <a href={`/app/documents/${i.documentId}`} target="_blank" className="underline">
                        View file
                      </a>
                    ) : null}
                    {i.submittedAt ? <span>received {TIME.format(i.submittedAt)}</span> : null}
                    {i.verifiedAt ? (
                      <span>
                        verified {TIME.format(i.verifiedAt)}
                        {verifier ? ` by ${verifier}` : ""}
                      </span>
                    ) : null}
                    {i.note ? <span>“{i.note}”</span> : null}
                  </div>
                  {canDocs ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <ActionForm action={uploadChecklistAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="itemId" value={i.id} />
                        <input type="hidden" name="applicationId" value={app.id} />
                        <Input type="file" name="file" accept="image/*,application/pdf" className="h-9 w-56 py-1 text-xs" aria-label={`Upload ${i.label}`} />
                        <Button type="submit" size="sm" variant="outline">
                          {i.documentId ? "Replace" : "Upload"}
                        </Button>
                      </ActionForm>
                      <ActionForm action={verifyChecklistAction} inlineStatus>
                        <input type="hidden" name="itemId" value={i.id} />
                        <input type="hidden" name="applicationId" value={app.id} />
                        <input type="hidden" name="verified" value={i.verifiedAt ? "0" : "1"} />
                        <Button type="submit" size="sm" variant={i.verifiedAt ? "ghost" : "default"}>
                          {i.verifiedAt ? "Undo verification" : i.documentId ? "Verify" : "Verify (original seen)"}
                        </Button>
                      </ActionForm>
                    </div>
                  ) : null}
                </div>
              ))}
              {canDocs ? (
                <ActionForm action={addChecklistItemAction} className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <input type="hidden" name="applicationId" value={app.id} />
                  <Input name="label" placeholder="Add a document (e.g. Deed of sale)" className="min-w-48 flex-1" />
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="required" defaultChecked className="size-4" /> Required
                  </label>
                  <Button type="submit" size="sm" variant="outline">
                    Add
                  </Button>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Fees &amp; payments</CardTitle>
              <CardDescription>
                Charged <Money value={money.charged} /> · paid <Money value={money.paid} /> · balance{" "}
                <Money value={money.balance} className={money.balance > BigInt(0) ? "font-semibold" : ""} />
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <ul className="divide-y">
                {money.fees.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className={f.voidedAt ? "text-muted-foreground line-through" : ""}>{f.description}</span>
                    <span className="flex items-center gap-2">
                      <Money value={f.amountCentavos} className={f.voidedAt ? "line-through" : ""} />
                      {f.voidedAt ? <Badge variant="muted">void</Badge> : null}
                      {canVoid && !f.voidedAt ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-destructive">Void</summary>
                          <ActionForm action={voidFeeAction} className="mt-1 flex gap-1">
                            <input type="hidden" name="id" value={f.id} />
                            <input type="hidden" name="applicationId" value={app.id} />
                            <Input name="reason" placeholder="Reason" required className="h-8" />
                            <Button type="submit" size="sm" variant="destructive">
                              Void
                            </Button>
                          </ActionForm>
                        </details>
                      ) : null}
                    </span>
                  </li>
                ))}
                {money.fees.length === 0 ? <li className="py-2 text-muted-foreground">No fees yet.</li> : null}
              </ul>
              {canFee ? (
                <ActionForm action={addFeeAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="applicationId" value={app.id} />
                  <Input name="description" placeholder="Fee (e.g. LTFRB filing fee)" className="min-w-40 flex-1" required />
                  <Input name="amount" inputMode="decimal" placeholder="0.00" className="w-32" required aria-label="Amount" />
                  <Button type="submit" variant="outline" size="sm" className="h-10">
                    Add fee
                  </Button>
                </ActionForm>
              ) : null}
              <div>
                <p className="mb-1 font-medium">Payments</p>
                <ul className="divide-y">
                  {money.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <a href={`/app/applications/${app.id}/receipts/${p.id}`} target="_blank" className="font-mono text-xs underline">
                          {p.receiptNo}
                        </a>{" "}
                        {p.receivedOn} · {p.method.replace("_", " ")}
                        {p.referenceNo ? ` · ${p.referenceNo}` : ""}
                        {p.voidedAt ? <span className="block text-xs text-destructive">Void: {p.voidReason}</span> : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <Money value={p.amountCentavos} className={p.voidedAt ? "line-through" : ""} />
                        {canVoid && !p.voidedAt ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-destructive">Void</summary>
                            <ActionForm action={voidFeePaymentAction} className="mt-1 flex gap-1">
                              <input type="hidden" name="id" value={p.id} />
                              <input type="hidden" name="applicationId" value={app.id} />
                              <Input name="reason" placeholder="Reason" required className="h-8" />
                              <Button type="submit" size="sm" variant="destructive">
                                Void
                              </Button>
                            </ActionForm>
                          </details>
                        ) : null}
                      </span>
                    </li>
                  ))}
                  {money.payments.length === 0 ? <li className="py-2 text-muted-foreground">No payments yet.</li> : null}
                </ul>
              </div>
              {canPay ? (
                <ActionForm action={recordFeePaymentAction} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                  <input type="hidden" name="applicationId" value={app.id} />
                  <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
                  <Field label="Amount (₱)" htmlFor="pay-amount">
                    <Input id="pay-amount" name="amount" inputMode="decimal" required className="h-11" />
                  </Field>
                  <Field label="Method" htmlFor="pay-method">
                    <Select id="pay-method" name="method" defaultValue="cash" className="h-11">
                      <option value="cash">Cash</option>
                      <option value="gcash">GCash</option>
                      <option value="maya">Maya</option>
                      <option value="bank_transfer">Bank transfer</option>
                      <option value="other">Other</option>
                    </Select>
                  </Field>
                  <Field label="Reference no. (non-cash)" htmlFor="pay-ref">
                    <Input id="pay-ref" name="referenceNo" className="h-11" />
                  </Field>
                  <Field label="Date received" htmlFor="pay-date">
                    <Input id="pay-date" name="receivedOn" type="date" defaultValue={today} max={today} required className="h-11" />
                  </Field>
                  <Field label="Bank (bank transfers)" htmlFor="pay-bank">
                    <Input id="pay-bank" name="bankName" placeholder="BDO" className="h-11" />
                  </Field>
                  <Field label="Notes" htmlFor="pay-notes">
                    <Input id="pay-notes" name="notes" className="h-11" />
                  </Field>
                  <Button type="submit" className="sm:col-span-2">
                    Record payment
                  </Button>
                </ActionForm>
              ) : null}
              {commission ? (
                <p className="rounded-md bg-muted p-3 text-xs">
                  Referral commission for {commission.referrerName}: <Money value={commission.amountCentavos} /> ({commission.status}).
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          {canWork ? (
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
                {app.cancelReason && status.kind === "cancelled" ? <CardDescription>Cancelled: {app.cancelReason}</CardDescription> : null}
              </CardHeader>
              <CardContent>
                <ActionForm action={setStatusAction} className="flex flex-col gap-2">
                  <input type="hidden" name="applicationId" value={app.id} />
                  <Select name="statusKey" defaultValue={app.statusKey} aria-label="Status">
                    {statuses
                      .filter((s) => s.active || s.key === app.statusKey)
                      .map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                  </Select>
                  <Input name="note" placeholder="Note (e.g. hearing on Oct 20)" />
                  <Input name="cancelReason" placeholder="Reason (required if cancelled)" />
                  <Button type="submit">Update status</Button>
                </ActionForm>
                {app.typeKey === "driver_program" && (status.kind === "approved" || status.kind === "completed") && !app.driverId && canMakeDriver ? (
                  <ActionForm action={createDriverAction} className="mt-3 border-t pt-3">
                    <input type="hidden" name="applicationId" value={app.id} />
                    <p className="mb-2 text-xs text-muted-foreground">Approved: create the driver profile (status “applicant”) from this client.</p>
                    <Button type="submit" variant="outline">
                      Create driver profile
                    </Button>
                  </ActionForm>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-2 border-l pl-4 text-sm">
                {history.map(({ h, by }) => (
                  <li key={h.id}>
                    <span className="font-medium">{h.fromKey ? `${statusLabel.get(h.fromKey) ?? h.fromKey} → ` : ""}{statusLabel.get(h.toKey) ?? h.toKey}</span>
                    <span className="block text-xs text-muted-foreground">
                      {TIME.format(h.changedAt)}
                      {by ? ` · ${by}` : ""}
                    </span>
                    {h.note ? <span className="block text-xs">{h.note}</span> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          {canWork ? (
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm action={updateApplicationAction} className="flex flex-col gap-3">
                  <input type="hidden" name="applicationId" value={app.id} />
                  <Field label="Reference no. (LTFRB case / platform)" htmlFor="referenceNo">
                    <Input id="referenceNo" name="referenceNo" defaultValue={app.referenceNo} />
                  </Field>
                  <Field label="Filed / submitted on" htmlFor="filedOn">
                    <Input id="filedOn" name="filedOn" type="date" defaultValue={app.filedOn ?? ""} />
                  </Field>
                  <Field label="Assigned to" htmlFor="assignedTo">
                    <Select id="assignedTo" name="assignedTo" defaultValue={app.assignedTo ?? ""}>
                      <option value="">Nobody</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Vehicle" htmlFor="vehicleId">
                    <Select id="vehicleId" name="vehicleId" defaultValue={app.vehicleId ?? ""}>
                      <option value="">—</option>
                      {vehicleList.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.plateNo}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Referred by" htmlFor="referrerName">
                    <Input id="referrerName" name="referrerName" defaultValue={app.referrerName} />
                  </Field>
                  <Field label="Referrer's mobile" htmlFor="referrerPhone">
                    <Input id="referrerPhone" name="referrerPhone" defaultValue={app.referrerPhone} />
                  </Field>
                  <Field label="Notes" htmlFor="appNotes">
                    <textarea id="appNotes" name="notes" rows={3} defaultValue={app.notes} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm" />
                  </Field>
                  <Button type="submit" variant="outline">
                    Save details
                  </Button>
                </ActionForm>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

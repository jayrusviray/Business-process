import { and, asc, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { applications, applicationTypes, leadActivities, leadFollowups, leads, leadStages, profiles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { CONTACT_LABELS, followupBucket, SERVICE_LINE_LABELS, SOURCE_LABELS, type ContactMethod } from "@/lib/crm";
import { addDays, businessToday, type IsoDate } from "@/lib/dates";
import { listAgents, listApplicationStaff } from "@/server/queries/staff";
import { convertLeadAction } from "../../applications/actions";
import { addFollowupAction, addNoteAction, assignLeadAction, completeFollowupAction, eraseLeadAction, moveLeadAction, updateLeadAction } from "../actions";
import { LeadFields } from "../lead-fields";

export const metadata = { title: "Lead" };

const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
const KIND_LABEL: Record<string, string> = {
  note: "Note",
  call: "Call",
  message: "Message",
  inquiry: "Inquiry",
  stage_change: "Stage",
  assignment: "Assigned",
  follow_up_done: "Follow-up",
  converted: "Converted",
  import: "Import",
};

export default async function LeadPage({ params }: PageProps<"/app/crm/[id]">) {
  const session = await requireRole(["owner_admin", "operations", "sales"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withUserTx(session.claims, async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, id));
    if (!lead) return null;
    const stages = await tx.select().from(leadStages).orderBy(asc(leadStages.sort));
    const activities = await tx
      .select({ a: leadActivities, by: profiles.fullName })
      .from(leadActivities)
      .leftJoin(profiles, eq(profiles.id, leadActivities.createdBy))
      .where(eq(leadActivities.leadId, id))
      .orderBy(desc(leadActivities.createdAt))
      .limit(200);
    const followups = await tx
      .select({ f: leadFollowups, agent: profiles.fullName })
      .from(leadFollowups)
      .leftJoin(profiles, eq(profiles.id, leadFollowups.assignedTo))
      .where(and(eq(leadFollowups.leadId, id), isNull(leadFollowups.doneAt)))
      .orderBy(asc(leadFollowups.dueOn));
    const agents = await listAgents(tx);
    const appStaff = await listApplicationStaff(tx);
    const types = await tx.select().from(applicationTypes).where(eq(applicationTypes.active, true)).orderBy(asc(applicationTypes.sort));
    const apps = await tx
      .select({ id: applications.id, appNo: applications.appNo, typeKey: applications.typeKey })
      .from(applications)
      .where(eq(applications.leadId, id))
      .orderBy(desc(applications.createdAt));
    return { lead, stages, activities, followups, agents, types, apps, appStaff };
  });
  if (!data) notFound();
  const { lead, stages, activities, followups, agents, types, apps, appStaff } = data;
  const stage = stages.find((s) => s.key === lead.stageKey);
  const today = businessToday();
  const isAdmin = session.roles.includes("owner_admin");

  return (
    <>
      <PageHeader
        title={lead.name}
        description={`${SERVICE_LINE_LABELS[lead.interest]} · ${SOURCE_LABELS[lead.source]}${lead.location ? ` · ${lead.location}` : ""}`}
        actions={<Badge variant={stage?.kind === "won" ? "success" : stage?.kind === "lost" ? "muted" : "default"}>{stage?.label ?? lead.stageKey}</Badge>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {lead.mobile ? (
          <>
            <Button asChild size="lg">
              <a href={`tel:${lead.mobile}`}>Call {lead.mobile}</a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={`sms:${lead.mobile}`}>Text</a>
            </Button>
          </>
        ) : null}
        {lead.email ? (
          <Button asChild size="lg" variant="outline">
            <a href={`mailto:${lead.email}`}>Email</a>
          </Button>
        ) : null}
        {lead.fbName ? <span className="self-center text-sm text-muted-foreground">Facebook: {lead.fbName}</span> : null}
        {lead.preferredContact ? <Badge variant="muted" className="self-center">prefers {CONTACT_LABELS[lead.preferredContact as ContactMethod]}</Badge> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ActionForm action={addNoteAction} className="flex flex-col gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <textarea name="body" rows={2} required placeholder="What happened? (call summary, what they need…)" className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm" />
                <div className="flex gap-2">
                  <Select name="kind" defaultValue="call" className="w-36" aria-label="Type">
                    <option value="call">Call</option>
                    <option value="message">Message</option>
                    <option value="note">Note</option>
                  </Select>
                  <Button type="submit" variant="outline">
                    Add
                  </Button>
                </div>
              </ActionForm>
              <ol className="flex flex-col gap-3 border-l pl-4">
                {activities.length === 0 ? <li className="text-sm text-muted-foreground">Nothing yet.</li> : null}
                {activities.map(({ a, by }) => (
                  <li key={a.id} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="muted">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                      {TIME.format(a.createdAt)}
                      {by ? ` · ${by}` : ""}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{a.body}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Edit details</summary>
            <Card className="mt-3">
              <CardContent className="pt-5">
                <ActionForm action={updateLeadAction} className="flex flex-col gap-4">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <LeadFields lead={lead} />
                  <Button type="submit">Save details</Button>
                </ActionForm>
              </CardContent>
            </Card>
          </details>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Stage</CardTitle>
              {lead.lostReason && stage?.kind === "lost" ? <CardDescription>Lost: {lead.lostReason}</CardDescription> : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ActionForm action={moveLeadAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Select name="stageKey" defaultValue={lead.stageKey} className="flex-1" aria-label="Stage">
                  {stages
                    .filter((s) => s.active || s.key === lead.stageKey)
                    .map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                </Select>
                <Button type="submit" variant="outline">
                  Move
                </Button>
                <Input name="lostReason" placeholder="Reason (required if lost)" className="basis-full" />
              </ActionForm>
              <ActionForm action={assignLeadAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Select name="userId" defaultValue={lead.assignedTo ?? ""} className="flex-1" aria-label="Assigned agent">
                  <option value="">Unassigned</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="outline">
                  Assign
                </Button>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Application</CardTitle>
              <CardDescription>Open a client application from this lead (the lead is marked converted).</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {apps.map((a) => (
                <Link key={a.id} href={`/app/applications/${a.id}`} className="text-sm underline">
                  {a.appNo} · {types.find((t) => t.key === a.typeKey)?.label ?? a.typeKey}
                </Link>
              ))}
              <ActionForm action={convertLeadAction} className="flex flex-col gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Select name="typeKey" defaultValue={types.find((t) => t.serviceLine === lead.interest)?.key ?? ""} required aria-label="Application type">
                  <option value="" disabled>
                    Choose the application type
                  </option>
                  {types.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <Select name="assignedTo" defaultValue={lead.assignedTo ?? session.userId} aria-label="Handled by">
                  {appStaff.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="outline">
                  Open application
                </Button>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Follow-ups</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {followups.length === 0 ? <p className="text-sm text-muted-foreground">No follow-up scheduled.</p> : null}
              {followups.map(({ f, agent }) => {
                const b = followupBucket(f.dueOn as IsoDate, today);
                return (
                  <div key={f.id} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{f.note || "Follow up"}</span>
                      <Badge variant={b === "overdue" ? "destructive" : b === "today" ? "warning" : "muted"}>{f.dueOn}</Badge>
                    </div>
                    {agent ? <p className="text-xs text-muted-foreground">{agent}</p> : null}
                    <ActionForm action={completeFollowupAction} className="mt-2 flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={f.id} />
                      <Input name="outcome" placeholder="What happened?" className="basis-full" />
                      <Input name="nextDueOn" type="date" min={today} aria-label="Next follow-up (optional)" className="w-40" />
                      <Input name="nextNote" placeholder="Next step (optional)" className="flex-1" />
                      <Button type="submit" size="sm">
                        Done
                      </Button>
                    </ActionForm>
                  </div>
                );
              })}
              <ActionForm action={addFollowupAction} className="flex flex-wrap gap-2 border-t pt-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <Input name="dueOn" type="date" required defaultValue={addDays(today, 1)} min={today} className="w-40" aria-label="Due" />
                <Input name="note" placeholder="e.g. Send CPC requirements" className="flex-1" />
                <Select name="assignedTo" defaultValue={lead.assignedTo ?? session.userId} className="basis-full" aria-label="Who follows up">
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="outline" className="basis-full">
                  Schedule follow-up
                </Button>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{TIME.format(lead.createdAt)}</dd>
                {lead.referrerName ? (
                  <>
                    <dt className="text-muted-foreground">Referred by</dt>
                    <dd>
                      {lead.referrerName}
                      {lead.referrerPhone ? ` · ${lead.referrerPhone}` : ""}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Privacy consent</dt>
                <dd>{lead.consentAt ? TIME.format(lead.consentAt) : "not recorded"}</dd>
                {lead.convertedAt ? (
                  <>
                    <dt className="text-muted-foreground">Converted</dt>
                    <dd>{TIME.format(lead.convertedAt)}</dd>
                  </>
                ) : null}
              </dl>
              {lead.message ? <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{lead.message}</p> : null}
              {lead.notes ? <p className="mt-3 whitespace-pre-wrap text-sm">{lead.notes}</p> : null}
            </CardContent>
          </Card>

          {isAdmin ? (
            <Card>
              <CardHeader>
                <CardTitle>Data privacy (RA 10173)</CardTitle>
                <CardDescription>For requests from this person to see or delete their data.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Button asChild variant="outline" size="sm" className="self-start">
                  <a href={`/app/crm/${lead.id}/export`}>Download their data (JSON)</a>
                </Button>
                <details>
                  <summary className="cursor-pointer text-sm text-destructive">Erase this lead</summary>
                  <ActionForm action={eraseLeadAction} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="leadId" value={lead.id} />
                    <Field label='Type "ERASE" to confirm' htmlFor="confirm">
                      <Input id="confirm" name="confirm" autoComplete="off" required />
                    </Field>
                    <Input name="notes" placeholder="Request reference (no personal details)" />
                    <Button type="submit" variant="destructive">
                      Erase permanently
                    </Button>
                  </ActionForm>
                </details>
                <Link href="/app/crm" className="text-xs text-muted-foreground underline">
                  Back to leads
                </Link>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

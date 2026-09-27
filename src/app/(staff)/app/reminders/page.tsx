import { asc, sql } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Table, Td, Th } from "@/components/ui/table";
import { withUserTx } from "@/db/client";
import { messageOptOuts, messageTemplates, reminderRules } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { toDecimalString } from "@/lib/money";
import { TEMPLATE_VARIABLES, TRIGGER_LABEL, type Trigger } from "@/lib/reminders";
import { cn } from "@/lib/utils";
import { listActiveDriversForPicker } from "@/server/queries/drivers";
import { listOutbox } from "@/server/reminders";
import {
  addOptOutAction,
  generateNowAction,
  manualMessageAction,
  markMessageAction,
  removeOptOutAction,
  saveRuleAction,
  saveTemplateAction,
} from "./actions";
import { OutboxSend } from "./outbox-item";

export const metadata = { title: "Reminders" };

const TABS = [
  ["outbox", "Outbox"],
  ["log", "Log"],
  ["templates", "Templates"],
  ["schedules", "Schedules"],
  ["optouts", "Opt-outs"],
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

export default async function RemindersPage({ searchParams }: PageProps<"/app/reminders">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const isAdmin = hasAnyRole(session.roles, ["owner_admin"]);
  const sp = await searchParams;
  const tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "outbox") as (typeof TABS)[number][0];

  return (
    <>
      <PageHeader
        title="Reminders"
        description="Reminders are prepared every morning at 8:00. Send each one from your phone with Open SMS, then mark it sent."
        actions={
          <ActionForm action={generateNowAction} inlineStatus className="flex flex-col items-end gap-1">
            <Button type="submit" variant="outline">Prepare today&apos;s reminders now</Button>
          </ActionForm>
        }
      />
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b text-sm">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/app/reminders?tab=${k}`} className={cn("whitespace-nowrap border-b-2 px-3 py-2", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground")}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "outbox" ? <Outbox claims={session.claims} /> : null}
      {tab === "log" ? <Log claims={session.claims} /> : null}
      {tab === "templates" ? <Templates claims={session.claims} isAdmin={isAdmin} /> : null}
      {tab === "schedules" ? <Schedules claims={session.claims} isAdmin={isAdmin} /> : null}
      {tab === "optouts" ? <OptOuts claims={session.claims} isAdmin={isAdmin} /> : null}
    </>
  );
}

type Claims = Parameters<typeof withUserTx>[0];

async function Outbox({ claims }: { claims: Claims }) {
  const { items, drivers } = await withUserTx(claims, async (tx) => ({ items: await listOutbox(tx), drivers: await listActiveDriversForPicker(tx) }));
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="flex flex-col gap-3">
        {items.length === 0 ? (
          <Card><CardContent className="pt-5 text-sm text-muted-foreground">Nothing to send. 🎉</CardContent></Card>
        ) : null}
        {items.map((m) => (
          <Card key={m.id}>
            <CardContent className="flex flex-col gap-3 pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {m.driver_id ? <Link href={`/app/drivers/${m.driver_id}`} className="underline-offset-2 hover:underline">{m.name}</Link> : m.to_phone}
                  <span className="ml-2 text-sm text-muted-foreground">{m.to_phone}</span>
                </span>
                <Badge variant="muted">{TRIGGER_LABEL[m.trigger as Trigger] ?? m.trigger}</Badge>
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{m.body}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <OutboxSend phone={m.to_phone} body={m.body} />
                <div className="flex gap-2">
                  <ActionForm action={markMessageAction} inlineStatus>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="status" value="sent" />
                    <Button type="submit" size="sm" variant="secondary">Mark sent</Button>
                  </ActionForm>
                  <ActionForm action={markMessageAction} inlineStatus>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="status" value="skipped" />
                    <Button type="submit" size="sm" variant="ghost">Skip</Button>
                  </ActionForm>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="self-start">
        <CardHeader>
          <CardTitle>Write a message</CardTitle>
          <CardDescription>Adds a one-off message to the outbox (and to the log).</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={manualMessageAction} className="flex flex-col gap-3">
            <Field label="Driver" htmlFor="driverId">
              <Select id="driverId" name="driverId" required>
                <option value="">Choose…</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.plate_no ? ` (${d.plate_no})` : ""}</option>)}
              </Select>
            </Field>
            <Field label="Message" htmlFor="body">
              <Textarea id="body" name="body" rows={4} className="font-sans" required />
            </Field>
            <Button type="submit" className="self-start">Add to outbox</Button>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}

async function Log({ claims }: { claims: Claims }) {
  const rows = await withUserTx(claims, (tx) =>
    tx.execute<{ id: string; created_at: string; handled_at: string | null; name: string | null; to_phone: string; trigger: string; status: string; body: string; handler: string | null }>(sql`
      SELECT m.id, m.created_at, m.handled_at, d.first_name || ' ' || d.last_name AS name, m.to_phone, m.trigger, m.status, m.body,
        COALESCE(NULLIF(p.full_name, ''), p.email) AS handler
      FROM public.messages m LEFT JOIN public.drivers d ON d.id = m.driver_id LEFT JOIN public.profiles p ON p.id = m.handled_by
      ORDER BY m.created_at DESC LIMIT 200`),
  );
  return (
    <Card>
      <Table>
        <thead><tr><Th>Prepared</Th><Th>To</Th><Th>Type</Th><Th>Status</Th><Th>Message</Th></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <Td className="whitespace-nowrap">{TIME.format(new Date(m.created_at))}</Td>
              <Td>{m.name ?? ""}<div className="text-xs text-muted-foreground">{m.to_phone}</div></Td>
              <Td>{TRIGGER_LABEL[m.trigger as Trigger] ?? m.trigger}</Td>
              <Td>
                <Badge variant={m.status === "sent" ? "success" : m.status === "pending" ? "warning" : "muted"}>{m.status}</Badge>
                {m.handled_at ? <div className="text-xs text-muted-foreground">{m.handler} · {TIME.format(new Date(m.handled_at))}</div> : null}
              </Td>
              <Td className="max-w-md text-xs">{m.body}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

async function Templates({ claims, isAdmin }: { claims: Claims; isAdmin: boolean }) {
  const rows = await withUserTx(claims, (tx) => tx.select().from(messageTemplates).orderBy(asc(messageTemplates.key), asc(messageTemplates.language)));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {rows.map((t) => (
        <Card key={t.id}>
          <CardHeader>
            <CardTitle className="text-base">{TRIGGER_LABEL[t.key as Trigger] ?? t.key} · {t.language === "en" ? "English" : "Taglish"}</CardTitle>
            <CardDescription>Variables: {(TEMPLATE_VARIABLES[t.key as Trigger] ?? []).map((v) => `{{${v}}}`).join(" ")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveTemplateAction} className="flex flex-col gap-2">
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="key" value={t.key} />
              <Textarea name="body" defaultValue={t.body} rows={3} className="font-sans" readOnly={!isAdmin} aria-label={`${t.key} ${t.language}`} />
              {isAdmin ? <Button type="submit" size="sm" variant="outline" className="self-start">Save</Button> : null}
            </ActionForm>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

async function Schedules({ claims, isAdmin }: { claims: Claims; isAdmin: boolean }) {
  const rows = await withUserTx(claims, (tx) => tx.select().from(reminderRules).orderBy(asc(reminderRules.trigger)));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {rows.filter((r) => r.trigger !== "manual").map((r) => (
        <Card key={r.trigger}>
          <CardHeader>
            <CardTitle className="text-base">{TRIGGER_LABEL[r.trigger as Trigger]}</CardTitle>
            <CardDescription>{r.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveRuleAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="trigger" value={r.trigger} />
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" name="active" defaultChecked={r.active} disabled={!isAdmin} className="size-4" /> Active
              </label>
              {r.trigger === "balance_weekly" ? (
                <>
                  <Field label="Day" htmlFor={`wd-${r.trigger}`}>
                    <Select id={`wd-${r.trigger}`} name="weekday" defaultValue={String(r.weekday ?? 1)} disabled={!isAdmin}>
                      {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </Select>
                  </Field>
                  <Field label="Minimum balance" htmlFor={`min-${r.trigger}`}>
                    <Input id={`min-${r.trigger}`} name="minAmount" inputMode="decimal" defaultValue={toDecimalString(r.minAmountCentavos)} disabled={!isAdmin} className="w-32" />
                  </Field>
                </>
              ) : r.offsetDays !== null ? (
                <Field label={r.trigger.includes("missed") ? "Days after due" : "Days before"} htmlFor={`off-${r.trigger}`}>
                  <Input id={`off-${r.trigger}`} name="offsetDays" inputMode="numeric" defaultValue={String(r.offsetDays)} disabled={!isAdmin} className="w-24" />
                </Field>
              ) : null}
              {isAdmin ? <Button type="submit" size="sm" variant="outline">Save</Button> : null}
            </ActionForm>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

async function OptOuts({ claims, isAdmin }: { claims: Claims; isAdmin: boolean }) {
  const rows = await withUserTx(claims, (tx) => tx.select().from(messageOptOuts).orderBy(asc(messageOptOuts.phone)));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Add opt-out</CardTitle><CardDescription>Numbers here never get automatic reminders.</CardDescription></CardHeader>
        <CardContent>
          <ActionForm action={addOptOutAction} className="flex flex-wrap items-end gap-2">
            <Field label="Mobile number" htmlFor="phone"><Input id="phone" name="phone" type="tel" required /></Field>
            <Field label="Reason" htmlFor="reason"><Input id="reason" name="reason" /></Field>
            <Button type="submit">Add</Button>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <Table>
          <thead><tr><Th>Number</Th><Th>Reason</Th><Th /></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><Td colSpan={3} className="text-muted-foreground">No opt-outs.</Td></tr> : null}
            {rows.map((o) => (
              <tr key={o.phone}>
                <Td>{o.phone}</Td>
                <Td>{o.reason}</Td>
                <Td>
                  {isAdmin ? (
                    <ActionForm action={removeOptOutAction} inlineStatus>
                      <input type="hidden" name="phone" value={o.phone} />
                      <Button type="submit" size="sm" variant="ghost">Remove</Button>
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

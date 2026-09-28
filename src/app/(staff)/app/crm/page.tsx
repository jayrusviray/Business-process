import { asc } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { leadStages } from "@/db/schema";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { followupBucket, leadAgeDays, LEAD_SOURCES, SERVICE_LINE_LABELS, SOURCE_LABELS, type LeadSource, type ServiceLine } from "@/lib/crm";
import { businessToday, type IsoDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { boardLeads, overdueFollowupCount } from "@/server/queries/crm";
import { moveLeadAction } from "./actions";

export const metadata = { title: "Leads" };

/** CRM pipeline board. Columns are the configurable stages; each card can be moved without drag-and-drop (works on phones). */
export default async function CrmBoardPage({ searchParams }: PageProps<"/app/crm">) {
  const session = await requireRole(["owner_admin", "operations", "sales"]);
  const sp = await searchParams;
  const isAgent = session.roles.includes("sales") && !hasAnyRole(session.roles, ["owner_admin", "operations"]);
  const who = sp.who === "mine" || sp.who === "unassigned" || sp.who === "all" ? sp.who : isAgent ? "mine" : "all";
  const q = typeof sp.q === "string" ? sp.q : "";
  const source = typeof sp.source === "string" && (LEAD_SOURCES as readonly string[]).includes(sp.source) ? sp.source : "";
  const today = businessToday();
  const { stages, rows, overdue } = await withUserTx(session.claims, async (tx) => ({
    stages: await tx.select().from(leadStages).orderBy(asc(leadStages.sort)),
    rows: await boardLeads(tx, { who, userId: session.userId, q, source }),
    overdue: await overdueFollowupCount(tx, session.userId, today),
  }));
  const active = stages.filter((s) => s.active);

  return (
    <>
      <PageHeader
        title="Leads"
        description="Facebook, Messenger, website and walk-in leads. Move a card when the lead progresses."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/app/crm/new">New lead</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/app/crm/followups">
                Follow-ups{overdue ? <Badge variant="destructive" className="ml-1">{overdue}</Badge> : null}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/app/crm/import">Import CSV</Link>
            </Button>
            {session.roles.includes("owner_admin") ? (
              <Button asChild variant="ghost">
                <Link href="/app/crm/stages">Stages</Link>
              </Button>
            ) : null}
          </div>
        }
      />
      {sp.erased ? <p role="status" className="mb-3 rounded-md bg-success/15 p-3 text-sm">The lead and its history were erased.</p> : null}
      <form className="mb-4 flex flex-wrap gap-2">
        <Select name="who" defaultValue={who} className="w-40" aria-label="Whose leads">
          <option value="mine">My leads</option>
          <option value="unassigned">Unassigned</option>
          <option value="all">Everyone&apos;s</option>
        </Select>
        <Select name="source" defaultValue={source} className="w-44" aria-label="Source">
          <option value="">All sources</option>
          {LEAD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </Select>
        <Input name="q" defaultValue={q} placeholder="Search name, FB name or mobile" className="w-60" />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
        {active.map((stage) => {
          const cards = rows.filter((r) => r.stage_key === stage.key);
          return (
            <section key={stage.key} className="flex w-72 shrink-0 snap-start flex-col gap-2 rounded-lg bg-muted/60 p-2" aria-label={stage.label}>
              <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
                {stage.label}
                <Badge variant={stage.kind === "won" ? "success" : stage.kind === "lost" ? "muted" : "default"}>{cards.length}</Badge>
              </h2>
              {stage.kind !== "open" ? <p className="px-1 text-xs text-muted-foreground">Last 30 days</p> : null}
              {cards.map((l) => {
                const bucket = l.next_due ? followupBucket(l.next_due as IsoDate, today) : null;
                return (
                  <article key={l.id} className="rounded-md border bg-card p-3 text-sm shadow-sm">
                    <Link href={`/app/crm/${l.id}`} className="font-medium underline-offset-2 hover:underline">
                      {l.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {SERVICE_LINE_LABELS[l.interest as ServiceLine] ?? l.interest}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="muted">{SOURCE_LABELS[l.source as LeadSource] ?? l.source}</Badge>
                      <Badge variant="muted">{leadAgeDays(l.created_on as IsoDate, today)}d</Badge>
                      {bucket ? (
                        <Badge variant={bucket === "overdue" ? "destructive" : bucket === "today" ? "warning" : "muted"}>
                          follow up {bucket === "overdue" ? "overdue" : bucket === "today" ? "today" : l.next_due}
                        </Badge>
                      ) : stage.kind === "open" ? (
                        <Badge variant="warning">no follow-up</Badge>
                      ) : null}
                    </div>
                    {who !== "mine" ? <p className="mt-1 text-xs text-muted-foreground">{l.agent ?? "Unassigned"}</p> : null}
                    <ActionForm action={moveLeadAction} className={cn("mt-2 flex flex-wrap gap-1")} inlineStatus>
                      <input type="hidden" name="leadId" value={l.id} />
                      <Select name="stageKey" defaultValue={l.stage_key} className="h-9 flex-1 text-sm" aria-label={`Move ${l.name} to`}>
                        {active.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" size="sm" variant="outline" className="h-9">
                        Move
                      </Button>
                      <Input name="lostReason" placeholder="Reason (if lost)" className="h-9 basis-full text-sm" />
                    </ActionForm>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </>
  );
}

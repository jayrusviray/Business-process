import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { hasAnyRole } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { followupBucket, type FollowupBucket } from "@/lib/crm";
import { businessToday, type IsoDate } from "@/lib/dates";
import { openFollowups } from "@/server/queries/crm";
import { completeFollowupAction } from "../actions";

export const metadata = { title: "Follow-ups" };

const GROUPS: { key: FollowupBucket; title: string }[] = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Today" },
  { key: "soon", title: "Next 7 days" },
  { key: "later", title: "Later" },
];

/** An agent's follow-up list (owner/admin and operations can see everyone's). */
export default async function FollowupsPage({ searchParams }: PageProps<"/app/crm/followups">) {
  const session = await requireRole(["owner_admin", "operations", "sales"]);
  const sp = await searchParams;
  const canSeeAll = hasAnyRole(session.roles, ["owner_admin", "operations"]);
  const all = canSeeAll && sp.all === "1";
  const today = businessToday();
  const rows = await withUserTx(session.claims, (tx) => openFollowups(tx, { userId: session.userId, all }));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Follow-ups"
        description={all ? "Everyone's open follow-ups." : "Your open follow-ups. Overdue ones first."}
        actions={
          canSeeAll ? (
            <Button asChild variant="outline">
              <Link href={all ? "/app/crm/followups" : "/app/crm/followups?all=1"}>{all ? "Mine only" : "Everyone's"}</Link>
            </Button>
          ) : null
        }
      />
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to follow up. 🎉</p> : null}
      {GROUPS.map((g) => {
        const items = rows.filter((r) => followupBucket(r.due_on as IsoDate, today) === g.key);
        if (items.length === 0) return null;
        return (
          <section key={g.key} className="mb-6">
            <h2 className={`mb-2 text-sm font-semibold ${g.key === "overdue" ? "text-destructive" : ""}`}>
              {g.title} ({items.length})
            </h2>
            <ul className="flex flex-col gap-2">
              {items.map((f) => (
                <li key={f.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/app/crm/${f.lead_id}`} className="font-medium underline-offset-2 hover:underline">
                      {f.lead_name}
                    </Link>
                    <span className="flex items-center gap-1">
                      <Badge variant="muted">{f.stage}</Badge>
                      <Badge variant={g.key === "overdue" ? "destructive" : g.key === "today" ? "warning" : "muted"}>{f.due_on}</Badge>
                    </span>
                  </div>
                  <p className="text-sm">{f.note || "Follow up"}</p>
                  <p className="text-xs text-muted-foreground">
                    {f.mobile ? (
                      <a href={`tel:${f.mobile}`} className="underline">
                        {f.mobile}
                      </a>
                    ) : null}
                    {all && f.agent ? ` · ${f.agent}` : ""}
                  </p>
                  <ActionForm action={completeFollowupAction} className="mt-2 flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={f.id} />
                    <Input name="outcome" placeholder="What happened?" className="min-w-40 flex-1" />
                    <Input name="nextDueOn" type="date" min={today} className="w-40" aria-label="Next follow-up (optional)" />
                    <Input name="nextNote" placeholder="Next step" className="min-w-32 flex-1" />
                    <Button type="submit">Done</Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

import { desc, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { withUserTx } from "@/db/client";
import { notifications } from "@/db/schema";
import { requireStaff } from "@/lib/auth/session";
import { markAllReadAction } from "./actions";

export const metadata = { title: "Notifications" };

const TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

export default async function NotificationsPage() {
  const session = await requireStaff();
  const rows = await withUserTx(session.claims, (tx) =>
    tx.select().from(notifications).where(eq(notifications.userId, session.userId)).orderBy(desc(notifications.createdAt)).limit(100),
  );
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Notifications"
        actions={
          rows.some((r) => !r.readAt) ? (
            <ActionForm action={markAllReadAction} inlineStatus>
              <Button type="submit" variant="outline">
                Mark all read
              </Button>
            </ActionForm>
          ) : null
        }
      />
      <ul className="divide-y rounded-lg border">
        {rows.length === 0 ? <li className="p-4 text-sm text-muted-foreground">No notifications.</li> : null}
        {rows.map((n) => (
          <li key={n.id} className={n.readAt ? "" : "bg-primary/5"}>
            {/* Plain link: opening marks it read, so it must not be prefetched. */}
            <a href={`/app/notifications/${n.id}`} className="block p-4 hover:bg-muted">
              <p className={n.readAt ? "" : "font-medium"}>{n.title}</p>
              {n.body ? <p className="line-clamp-2 text-sm text-muted-foreground">{n.body}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">{TIME.format(n.createdAt)}</p>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

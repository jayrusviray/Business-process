import { and, count, eq, isNull } from "drizzle-orm";
import { Bell } from "lucide-react";
import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { MobileNav, StaffNav } from "@/components/staff-nav";
import { withUserTx } from "@/db/client";
import { notifications } from "@/db/schema";
import { requireStaff } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { navForRoles } from "@/lib/nav";

export default async function StaffLayout({ children }: LayoutProps<"/app">) {
  const session = await requireStaff();
  const sections = navForRoles(session.roles);
  const [unread] = await withUserTx(session.claims, (tx) =>
    tx.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, session.userId), isNull(notifications.readAt))),
  );
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r lg:flex lg:flex-col lg:gap-6 lg:p-4">
        <Link href="/app" className="px-2 text-lg font-semibold tracking-tight">
          TransRev
        </Link>
        <StaffNav sections={sections} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="relative flex h-14 items-center justify-between gap-3 border-b px-4">
          <div className="flex items-center gap-3">
            <MobileNav sections={sections} />
            <Link href="/app" className="font-semibold lg:hidden">
              TransRev
            </Link>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/app/notifications"
              className="relative rounded-md p-2 hover:bg-muted"
              aria-label={unread?.n ? `Notifications (${unread.n} unread)` : "Notifications"}
            >
              <Bell className="size-5" aria-hidden />
              {unread?.n ? (
                <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-destructive px-1 text-center text-[11px] font-semibold leading-5 text-destructive-foreground">
                  {unread.n > 99 ? "99+" : unread.n}
                </span>
              ) : null}
            </Link>
            <span className="hidden text-muted-foreground sm:inline">
              {session.profile.fullName || session.profile.email} ·{" "}
              {session.roles.map((r) => ROLE_LABELS[r]).join(", ")}
            </span>
            <SignOutButton />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

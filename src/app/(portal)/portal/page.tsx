import { SignOutButton } from "@/components/sign-out-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";

export const metadata = { title: "My account" };

/** Mobile-first driver/investor portal. Balances, calendar and statements arrive in Phase 3. */
export default async function PortalPage() {
  const session = await requireRole(["driver", "investor"]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <span className="font-semibold">TransRev</span>
        <SignOutButton />
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Hi{session.profile.fullName ? `, ${session.profile.fullName}` : ""}!</CardTitle>
          <CardDescription>
            Your balance, payment history, boundary calendar and RTO progress will appear here soon.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </main>
  );
}

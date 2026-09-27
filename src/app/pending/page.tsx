import { SignOutButton } from "@/components/sign-out-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PendingPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Account not yet activated</CardTitle>
          <CardDescription>
            Your account has no role assigned. Please ask a TransRev administrator to grant you access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton />
        </CardContent>
      </Card>
    </main>
  );
}

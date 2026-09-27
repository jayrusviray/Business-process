import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">TransRev</CardTitle>
          <CardDescription>Sign in to the operations system.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={typeof next === "string" ? next : undefined} />
          {/* Driver phone + OTP login arrives with the driver portal (Phase 3). */}
        </CardContent>
      </Card>
    </main>
  );
}

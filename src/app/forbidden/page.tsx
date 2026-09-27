import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4 text-center">
      <h1 className="text-xl font-semibold">You don&apos;t have access to this page</h1>
      <p className="text-sm text-muted-foreground">If you think this is a mistake, ask an administrator.</p>
      <Button asChild variant="outline">
        <Link href="/home">Go to my home page</Link>
      </Button>
    </main>
  );
}

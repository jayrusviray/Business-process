import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">The page you are looking for doesn&apos;t exist or was moved. Check the address, or start again from the home page.</p>
      <div className="flex gap-3">
        <Link href="/" className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Home page
        </Link>
        <Link href="/home" className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">
          My account
        </Link>
      </div>
    </main>
  );
}

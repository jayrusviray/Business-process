"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Friendly error message for error boundaries. Server errors reach the browser
 * only as a digest (never the message), which staff can quote when reporting.
 */
export function ErrorPanel({ error, retry, homeHref = "/" }: { error: Error & { digest?: string }; retry: () => void; homeHref?: string }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">
        Sorry, this page could not be loaded. Nothing you already saved is lost. Try again, and if it keeps happening, tell the office
        {error.digest ? (
          <>
            {" "}
            the code <span className="font-mono text-foreground">{error.digest}</span>
          </>
        ) : null}
        .
      </p>
      <div className="flex gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Button variant="outline" asChild>
          <Link href={homeHref}>Go back home</Link>
        </Button>
      </div>
    </div>
  );
}

"use client";

import { ErrorPanel } from "@/components/error-panel";

/** Keeps the staff navigation visible when one screen fails. */
export default function StaffError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorPanel error={error} retry={retry} homeHref="/app" />;
}

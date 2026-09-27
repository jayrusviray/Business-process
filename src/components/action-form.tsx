"use client";

import { useActionState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type State = { ok?: string; error?: string };

/** Thin wrapper around useActionState that shows the action's ok/error message. */
export function ActionForm({
  action,
  children,
  className,
  inlineStatus = false,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  children: ReactNode;
  className?: string;
  inlineStatus?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={cn(className, pending && "opacity-70")}>
      {children}
      {state.error || state.ok ? (
        <p
          role={state.error ? "alert" : "status"}
          className={cn("text-xs", inlineStatus ? "" : "basis-full", state.error ? "text-destructive" : "text-success")}
        >
          {state.error ?? state.ok}
        </p>
      ) : null}
    </form>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { smsHref, smsSegments } from "@/lib/reminders";

/** One outbox message: open the phone's SMS app pre-filled, or copy the text. */
export function OutboxSend({ phone, body }: { phone: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm">
        <a href={smsHref(phone, body)}>Open SMS</a>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked: user can still long-press the text */
          }
        }}
      >
        {copied ? "Copied" : "Copy text"}
      </Button>
      <span className="text-xs text-muted-foreground">
        {body.length} chars · {smsSegments(body)} SMS
      </span>
    </div>
  );
}

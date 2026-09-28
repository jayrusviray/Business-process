import "server-only";

/**
 * Email provider interface (M-D: nightly report). The default does nothing;
 * Resend is used when RESEND_API_KEY and REPORTS_EMAIL_FROM are set. Plain
 * fetch, no SDK. Another provider can be added without touching callers.
 */
export type EmailAttachment = { filename: string; content: Buffer };
export type EmailMessage = { to: string[]; subject: string; text: string; attachments?: EmailAttachment[] };
export type EmailResult = { status: "sent" | "skipped" | "failed"; id?: string; error?: string };

export interface EmailProvider {
  readonly name: string;
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<EmailResult>;
}

export const noopProvider: EmailProvider = {
  name: "none",
  configured: false,
  async send() {
    return { status: "skipped" };
  },
};

export function resendProvider(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    name: "resend",
    configured: true,
    async send(msg) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
        }),
      });
      if (!res.ok) return { status: "failed", error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { status: "sent", id: body.id };
    },
  };
}

export function getEmailProvider(env: Record<string, string | undefined> = process.env): EmailProvider {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.REPORTS_EMAIL_FROM?.trim();
  return key && from ? resendProvider(key, from) : noopProvider;
}

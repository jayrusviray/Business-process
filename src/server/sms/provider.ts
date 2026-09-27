/**
 * SMS provider interface. Owner (2026-09-27): no gateway account yet, so the
 * only implementation is "manual": messages wait in the outbox and staff send
 * them from their own phone. A gateway (e.g. Semaphore, M360, Globe Labs) can be
 * added later as another implementation without touching the reminder logic.
 */
export type SendResult = { status: "sent" | "pending" | "failed"; providerMessageId?: string; costCentavos?: bigint; error?: string };

export interface SmsProvider {
  readonly name: string;
  /** Deliver immediately if the provider can; manual providers leave it pending. */
  send(to: string, body: string): Promise<SendResult>;
}

export const manualProvider: SmsProvider = {
  name: "manual",
  async send() {
    return { status: "pending" };
  },
};

export function getSmsProvider(): SmsProvider {
  return manualProvider;
}

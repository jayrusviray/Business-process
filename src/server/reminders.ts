import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { messageOptOuts, messages, messageTemplates, reminderRules } from "@/db/schema";
import { addDays, type IsoDate } from "@/lib/dates";
import { planReminders, renderTemplate, type DriverFacts, type RuleConfig, type Trigger } from "@/lib/reminders";
import { rtoSchedule } from "@/lib/rto";
import { MoneyRuleError } from "./money/errors";
import { getRtoStatus } from "./money/rto";
import { getSmsProvider } from "./sms/provider";

/** Collects the per-driver facts the reminder rules look at. */
export async function gatherDriverFacts(tx: Tx, today: IsoDate): Promise<(DriverFacts & { language: "en" | "taglish" })[]> {
  const drivers = await tx.execute<{ id: string; first_name: string; phone: string; license_expiry: string | null; preferred_language: "en" | "taglish"; balance: string; contract_id: string | null }>(sql`
    SELECT d.id, d.first_name, d.phone, d.license_expiry::text, d.preferred_language,
      COALESCE((SELECT SUM(b.balance_centavos) FROM public.v_account_balances b WHERE b.driver_id = d.id), 0)::text AS balance,
      (SELECT c.id FROM public.rto_contracts c WHERE c.driver_id = d.id AND c.status = 'active' LIMIT 1) AS contract_id
    FROM public.drivers d WHERE d.status IN ('active', 'suspended')`);
  const days = await tx.execute<{ driver_id: string; due_date: string; amount: string; outstanding: string }>(sql`
    SELECT driver_id, due_date::text, SUM(amount_centavos)::text AS amount, SUM(outstanding_centavos)::text AS outstanding
    FROM public.v_charge_status
    WHERE entry_type = 'boundary_charge' AND due_date BETWEEN ${addDays(today, -7)}::date AND ${today}::date
    GROUP BY driver_id, due_date`);

  const out = [];
  for (const d of drivers) {
    let rto: DriverFacts["rto"] = null;
    if (d.contract_id) {
      const s = await getRtoStatus(tx, d.contract_id, today);
      if (s) {
        const posted = new Map(s.allocation.charges.map((c) => [c.dueDate, c]));
        rto = {
          contractNo: s.contract.contractNo,
          percentPaid: s.progress.percentPaid,
          missed: s.missed,
          installments: rtoSchedule(s.terms)
            .filter((i) => i.kind === "installment" && i.dueDate >= addDays(today, -31) && i.dueDate <= addDays(today, 31))
            .map((i) => ({ seq: i.seq, dueDate: i.dueDate, amount: i.amount, outstanding: posted.get(i.dueDate)?.outstanding ?? null })),
        };
      }
    }
    out.push({
      driverId: d.id,
      firstName: d.first_name,
      phone: d.phone,
      language: d.preferred_language,
      totalBalance: BigInt(d.balance),
      licenseExpiry: d.license_expiry as IsoDate | null,
      boundaryDays: days
        .filter((x) => x.driver_id === d.id)
        .map((x) => ({ dueDate: x.due_date as IsoDate, amount: BigInt(x.amount), outstanding: BigInt(x.outstanding) })),
      rto,
    });
  }
  return out;
}

async function loadTemplates(tx: Tx) {
  const rows = await tx.select().from(messageTemplates);
  return (key: string, lang: "en" | "taglish") =>
    rows.find((t) => t.key === key && t.language === lang)?.body ?? rows.find((t) => t.key === key && t.language === "en")?.body;
}

/**
 * Builds today's reminders into the outbox. Idempotent: each reminder has a
 * dedupe key, so running twice never duplicates. Opted-out numbers are skipped.
 */
export async function generateReminders(tx: Tx, today: IsoDate): Promise<{ created: number; optedOut: number; errors: string[] }> {
  const rules: RuleConfig[] = (await tx.select().from(reminderRules))
    .filter((r) => r.trigger !== "manual")
    .map((r) => ({ trigger: r.trigger as Trigger, active: r.active, weekday: r.weekday, offsetDays: r.offsetDays, minAmount: r.minAmountCentavos }));
  const template = await loadTemplates(tx);
  const optOuts = new Set((await tx.select({ phone: messageOptOuts.phone }).from(messageOptOuts)).map((o) => o.phone));
  const facts = await gatherDriverFacts(tx, today);
  const provider = getSmsProvider();
  let created = 0;
  let optedOut = 0;
  const errors: string[] = [];

  for (const f of facts) {
    const planned = planReminders(rules, f, today);
    if (planned.length && optOuts.has(f.phone)) {
      optedOut += planned.length;
      continue;
    }
    for (const p of planned) {
      const body = template(p.trigger, f.language);
      if (!body) {
        errors.push(`No template for ${p.trigger}`);
        continue;
      }
      let text: string;
      try {
        text = renderTemplate(body, p.vars);
      } catch (e) {
        errors.push(`${p.trigger}: ${(e as Error).message}`);
        continue;
      }
      const [row] = await tx
        .insert(messages)
        .values({ driverId: f.driverId, toPhone: f.phone, trigger: p.trigger, language: f.language, body: text, dedupeKey: p.dedupeKey, channel: `sms_${provider.name}` })
        .onConflictDoNothing({ target: messages.dedupeKey })
        .returning({ id: messages.id });
      if (row) created++;
    }
  }
  return { created, optedOut, errors: [...new Set(errors)] };
}

/** A one-off message typed by staff, added to the outbox. */
export async function queueManualMessage(tx: Tx, input: { driverId: string; body: string }): Promise<string> {
  const body = input.body.trim();
  if (!body) throw new MoneyRuleError("Type a message.");
  if (body.length > 918) throw new MoneyRuleError("Message is too long (max 6 SMS).");
  const [d] = await tx.execute<{ phone: string; preferred_language: "en" | "taglish" }>(sql`SELECT phone, preferred_language FROM public.drivers WHERE id = ${input.driverId}::uuid`);
  if (!d) throw new MoneyRuleError("Driver not found.");
  const [opt] = await tx.select().from(messageOptOuts).where(eq(messageOptOuts.phone, d.phone));
  if (opt) throw new MoneyRuleError("This number opted out of reminders.");
  const [row] = await tx
    .insert(messages)
    .values({ driverId: input.driverId, toPhone: d.phone, trigger: "manual", language: d.preferred_language, body })
    .returning({ id: messages.id });
  return row.id;
}

export async function markMessage(tx: Tx, id: string, status: "sent" | "skipped"): Promise<void> {
  const res = await tx.update(messages).set({ status }).where(eq(messages.id, id)).returning({ id: messages.id });
  if (res.length === 0) throw new MoneyRuleError("Message not found.");
}

export async function listOutbox(tx: Tx) {
  return tx.execute<{ id: string; driver_id: string | null; name: string | null; to_phone: string; trigger: string; body: string; created_at: string }>(sql`
    SELECT m.id, m.driver_id, d.first_name || ' ' || d.last_name AS name, m.to_phone, m.trigger, m.body, m.created_at::text
    FROM public.messages m LEFT JOIN public.drivers d ON d.id = m.driver_id
    WHERE m.status = 'pending' ORDER BY m.created_at, d.last_name`);
}


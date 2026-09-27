"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { messageOptOuts, messageTemplates, reminderRules } from "@/db/schema";
import { businessToday } from "@/lib/dates";
import { renderTemplate, TEMPLATE_VARIABLES, type Trigger } from "@/lib/reminders";
import { zPesoOrZero, zPhMobile } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { MoneyRuleError } from "@/server/money/errors";
import { generateReminders, markMessage, queueManualMessage } from "@/server/reminders";

const STAFF = ["owner_admin", "finance", "operations"] as const;

export async function generateNowAction(): Promise<ActionState> {
  return guarded(STAFF, async (s) => {
    const r = await withUserTx(s.claims, (tx) => generateReminders(tx, businessToday()));
    revalidatePath("/app/reminders");
    const parts = [`${r.created} new reminder(s) added to the outbox.`];
    if (r.optedOut) parts.push(`${r.optedOut} skipped (opted out).`);
    if (r.errors.length) parts.push(`Template problems: ${r.errors.join("; ")}`);
    return parts.join(" ");
  });
}

export async function markMessageAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(STAFF, async (s) => {
    const { id, status } = z.object({ id: z.guid(), status: z.enum(["sent", "skipped"]) }).parse(obj);
    await withUserTx(s.claims, (tx) => markMessage(tx, id, status));
    revalidatePath("/app/reminders");
    return status === "sent" ? "Marked as sent." : "Skipped.";
  });
}

export async function manualMessageAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(STAFF, async (s) => {
    const input = z.object({ driverId: z.guid("Choose a driver"), body: z.string() }).parse(obj);
    await withUserTx(s.claims, (tx) => queueManualMessage(tx, input));
    revalidatePath("/app/reminders");
    return "Added to the outbox.";
  });
}

export async function saveTemplateAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const { id, key, body } = z.object({ id: z.guid(), key: z.string(), body: z.string().trim().min(5).max(918) }).parse(obj);
    // Reject templates that reference variables this reminder can't fill.
    const vars = Object.fromEntries((TEMPLATE_VARIABLES[key as Trigger] ?? []).map((v) => [v, "x"]));
    try {
      renderTemplate(body, vars);
    } catch (e) {
      throw new MoneyRuleError(`${(e as Error).message}. Available: ${Object.keys(vars).map((v) => `{{${v}}}`).join(", ")}`);
    }
    await withUserTx(s.claims, (tx) => tx.update(messageTemplates).set({ body }).where(eq(messageTemplates.id, id)));
    revalidatePath("/app/reminders");
    return "Template saved.";
  });
}

export async function saveRuleAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const input = z
      .object({
        trigger: z.enum(["balance_weekly", "missed_boundary", "amortization_upcoming", "amortization_missed", "rto_milestone", "license_expiry"]),
        active: z.string().optional().transform((v) => v === "on"),
        weekday: z.union([z.literal(""), z.coerce.number().int().min(0).max(6)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
        offsetDays: z.union([z.literal(""), z.coerce.number().int().min(0).max(120)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
        minAmount: zPesoOrZero.optional(),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) =>
      tx
        .update(reminderRules)
        .set({ active: input.active, weekday: input.weekday, offsetDays: input.offsetDays, minAmountCentavos: input.minAmount ?? BigInt(0) })
        .where(eq(reminderRules.trigger, input.trigger)),
    );
    revalidatePath("/app/reminders");
    return "Schedule saved.";
  });
}

export async function addOptOutAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(STAFF, async (s) => {
    const { phone, reason } = z.object({ phone: zPhMobile, reason: z.string().trim().max(200).default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => tx.insert(messageOptOuts).values({ phone, reason }).onConflictDoNothing());
    revalidatePath("/app/reminders");
    return `${phone} will no longer receive reminders.`;
  });
}

export async function removeOptOutAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const { phone } = z.object({ phone: z.string() }).parse(obj);
    await withUserTx(s.claims, (tx) => tx.delete(messageOptOuts).where(and(eq(messageOptOuts.phone, phone), eq(messageOptOuts.channel, "sms"))));
    revalidatePath("/app/reminders");
    return "Opt-out removed.";
  });
}

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { quotaRules } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { friendlyError, MoneyRuleError } from "@/server/money/errors";
import { awardBonus, importQuotaCsv, parseQuotaValue, upsertQuotaResult, voidBonus } from "@/server/money/quotas";

const RuleInput = z.object({
  name: z.string().trim().min(2).max(120),
  metric: z.enum(["trips", "earnings_centavos"]),
  period: z.enum(["monthly", "weekly"]),
  threshold: z.string().trim(),
  bonus: zPesoOrZero,
  active: z.string().optional().transform((v) => v === "on"),
  notes: z.string().trim().max(500).default(""),
});

export async function saveRuleAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = RuleInput.parse(obj);
    const threshold = parseQuotaValue(input.metric, input.threshold);
    if (threshold <= BigInt(0)) throw new MoneyRuleError("Target must be more than zero.");
    if (input.active && input.bonus <= BigInt(0)) throw new MoneyRuleError("Set a bonus amount before activating the rule.");
    const values = { name: input.name, metric: input.metric, period: input.period, threshold, bonusCentavos: input.bonus, active: input.active, notes: input.notes };
    await withUserTx(s.claims, async (tx) => {
      if (obj.id) await tx.update(quotaRules).set(values).where(eq(quotaRules.id, z.guid().parse(obj.id)));
      else await tx.insert(quotaRules).values(values);
    });
    revalidatePath("/app/quotas");
    return "Rule saved.";
  });
}

/** Saves every filled-in count on the manual entry grid. */
export async function saveResultsAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance", "operations"], async (s) => {
    const { ruleId, periodDate } = z.object({ ruleId: z.guid(), periodDate: zIsoDate }).parse(obj);
    const [rule] = await withUserTx(s.claims, (tx) => tx.select().from(quotaRules).where(eq(quotaRules.id, ruleId)));
    if (!rule) throw new MoneyRuleError("Rule not found.");
    const entries = Object.entries(obj)
      .filter(([k, v]) => k.startsWith("value:") && v.trim() !== "")
      .map(([k, v]) => ({ driverId: z.guid().parse(k.slice(6)), value: parseQuotaValue(rule.metric, v), original: obj[`orig:${k.slice(6)}`] ?? "" }))
      .filter((e) => e.original !== e.value.toString());
    await withUserTx(s.claims, async (tx) => {
      for (const e of entries) {
        await upsertQuotaResult(tx, { ruleId, driverId: e.driverId, anyDateInPeriod: periodDate, value: e.value, source: "manual" });
      }
    });
    revalidatePath("/app/quotas");
    return entries.length ? `${entries.length} count(s) saved.` : "No changes.";
  });
}

export type ImportState = {
  ok?: string;
  error?: string;
  preview?: { line: number; identifier: string; rawValue: string; driverName?: string; value?: string; error?: string }[];
};

export async function importCsvAction(_: ImportState, formData: FormData): Promise<ImportState> {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  try {
    const { ruleId, periodDate, intent } = z
      .object({ ruleId: z.guid(), periodDate: zIsoDate, intent: z.enum(["preview", "import"]) })
      .parse(formObject(formData));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
    if (file.size > 2 * 1024 * 1024) return { error: "CSV is too large (max 2 MB)." };
    const text = await file.text();
    const res = await withUserTx(session.claims, (tx) =>
      importQuotaCsv(tx, { ruleId, anyDateInPeriod: periodDate, csvText: text, commit: intent === "import", fileName: file.name }),
    );
    const preview = res.rows.map((r) => ({ ...r, value: r.value?.toString(), driverId: undefined }));
    if (intent === "import") {
      revalidatePath("/app/quotas");
      return { ok: `Imported ${res.saved} row(s).`, preview };
    }
    const bad = preview.filter((r) => r.error).length;
    return { ok: bad ? `${bad} row(s) need fixing before import.` : `All ${preview.length} row(s) look good. Click Import to save.`, preview };
  } catch (e) {
    return { error: friendlyError(e) };
  }
}

export async function awardBonusAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z
      .object({ quotaResultId: z.guid(), mode: z.enum(["credit", "cash"]), reference: z.string().trim().max(120).default("") })
      .parse(obj);
    await withUserTx(s.claims, (tx) => awardBonus(tx, { ...input, paidOn: businessToday() }));
    revalidatePath("/app/quotas");
    return input.mode === "credit" ? "Bonus credited to the driver's balance." : "Cash bonus recorded.";
  });
}

export async function voidBonusAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ awardId: z.guid(), reason: z.string().trim().min(3, "Give a reason") }).parse(obj);
    await withUserTx(s.claims, (tx) => voidBonus(tx, { ...input, userId: s.userId, businessDate: businessToday() }));
    revalidatePath("/app/quotas");
    return "Bonus voided.";
  });
}

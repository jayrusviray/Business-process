import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { bonusAwards, driverAccounts, ledgerEntries, quotaResults, quotaRules } from "@/db/schema";
import { parseCsvObjects } from "@/lib/csv";
import type { IsoDate } from "@/lib/dates";
import { parsePeso } from "@/lib/money";
import { periodFor, type QuotaPeriod } from "@/lib/quotas";
import { MoneyRuleError } from "./errors";
import { ensureAccount, lockDriver } from "./fleet";
import { reverseEntry } from "./payments";

async function getRule(tx: Tx, ruleId: string) {
  const [rule] = await tx.select().from(quotaRules).where(eq(quotaRules.id, ruleId));
  if (!rule) throw new MoneyRuleError("Quota rule not found.");
  return rule;
}

/** Parses a result value: whole number for counts, pesos for earnings. */
export function parseQuotaValue(metric: string, raw: string): bigint {
  const s = raw.trim().replaceAll(",", "");
  if (metric === "earnings_centavos") return parsePeso(s);
  if (!/^\d+$/.test(s)) throw new MoneyRuleError(`"${raw}" is not a whole number`);
  return BigInt(s);
}

/** Creates or updates a driver's result for the rule period containing `anyDateInPeriod`. */
export async function upsertQuotaResult(
  tx: Tx,
  input: { ruleId: string; driverId: string; anyDateInPeriod: IsoDate; value: bigint; source: "manual" | "csv"; note?: string },
): Promise<string> {
  const rule = await getRule(tx, input.ruleId);
  if (input.value < BigInt(0)) throw new MoneyRuleError("Value cannot be negative.");
  const { start, end } = periodFor(rule.period as QuotaPeriod, input.anyDateInPeriod);
  const [row] = await tx
    .insert(quotaResults)
    .values({
      ruleId: rule.id,
      driverId: input.driverId,
      periodStart: start,
      periodEnd: end,
      value: input.value,
      source: input.source,
      sourceNote: input.note ?? "",
    })
    .onConflictDoUpdate({
      target: [quotaResults.driverId, quotaResults.ruleId, quotaResults.periodStart],
      set: { value: input.value, source: input.source, sourceNote: input.note ?? "" },
      setWhere: sql`${quotaResults.value} IS DISTINCT FROM ${input.value}`,
    })
    .returning({ id: quotaResults.id });
  if (row) return row.id;
  const [existing] = await tx
    .select({ id: quotaResults.id })
    .from(quotaResults)
    .where(and(eq(quotaResults.driverId, input.driverId), eq(quotaResults.ruleId, rule.id), eq(quotaResults.periodStart, start)));
  return existing.id;
}

export type ImportPreviewRow = {
  line: number;
  identifier: string;
  rawValue: string;
  driverId?: string;
  driverName?: string;
  value?: bigint;
  error?: string;
};

const ID_COLUMNS = ["driver_id", "mobile", "mobile_number", "phone", "phone_number", "contact", "plate", "plate_no", "plate_number"];
const VALUE_COLUMNS = ["value", "trips", "rides", "total_trips", "total_rides", "completed_trips", "earnings", "total_earnings"];

function normalisePhone(s: string): string {
  const d = s.replace(/[^\d]/g, "");
  if (d.startsWith("63") && d.length === 12) return `0${d.slice(2)}`;
  return d;
}

/**
 * CSV import from platform reports (any source: owner said ride counts can come
 * from anywhere). Matches drivers by driver id, mobile number or plate. With
 * `commit`, all rows are saved or none (any error aborts).
 */
export async function importQuotaCsv(
  tx: Tx,
  input: { ruleId: string; anyDateInPeriod: IsoDate; csvText: string; commit: boolean; fileName: string },
): Promise<{ rows: ImportPreviewRow[]; saved: number }> {
  const rule = await getRule(tx, input.ruleId);
  const { headers, rows } = parseCsvObjects(input.csvText);
  const idCol = ID_COLUMNS.find((c) => headers.includes(c));
  const valCol = VALUE_COLUMNS.find((c) => headers.includes(c));
  if (!idCol || !valCol) {
    throw new MoneyRuleError(
      `The CSV needs a driver column (${ID_COLUMNS.slice(0, 7).join(", ")}) and a value column (${VALUE_COLUMNS.join(", ")}). Found: ${headers.join(", ") || "nothing"}.`,
    );
  }
  const drivers = await tx.execute<{ id: string; name: string; phone: string; plate_no: string | null }>(sql`
    SELECT d.id, d.first_name || ' ' || d.last_name AS name, d.phone, v.plate_no
    FROM public.drivers d
    LEFT JOIN public.vehicle_assignments va ON va.driver_id = d.id AND va.end_date IS NULL
    LEFT JOIN public.vehicles v ON v.id = va.vehicle_id`);
  const byKey = new Map<string, { id: string; name: string }[]>();
  const add = (k: string, d: { id: string; name: string }) => byKey.set(k, [...(byKey.get(k) ?? []), d]);
  for (const d of drivers) {
    add(`id:${d.id}`, d);
    add(`phone:${normalisePhone(d.phone)}`, d);
    if (d.plate_no) add(`plate:${d.plate_no.replace(/\s+/g, "").toUpperCase()}`, d);
  }

  const seen = new Set<string>();
  const preview: ImportPreviewRow[] = rows.map((r, i) => {
    const identifier = r[idCol] ?? "";
    const rawValue = r[valCol] ?? "";
    const row: ImportPreviewRow = { line: i + 2, identifier, rawValue };
    const key = idCol === "driver_id" ? `id:${identifier}` : idCol.startsWith("plate") ? `plate:${identifier.replace(/\s+/g, "").toUpperCase()}` : `phone:${normalisePhone(identifier)}`;
    const matches = byKey.get(key) ?? [];
    if (matches.length !== 1) return { ...row, error: matches.length ? "Matches more than one driver" : "No matching driver" };
    if (seen.has(matches[0].id)) return { ...row, error: "Driver appears twice in the file" };
    seen.add(matches[0].id);
    try {
      return { ...row, driverId: matches[0].id, driverName: matches[0].name, value: parseQuotaValue(rule.metric, rawValue) };
    } catch (e) {
      return { ...row, driverId: matches[0].id, driverName: matches[0].name, error: e instanceof Error ? e.message : "Invalid value" };
    }
  });

  if (!input.commit) return { rows: preview, saved: 0 };
  const bad = preview.filter((r) => r.error);
  if (bad.length) throw new MoneyRuleError(`Fix ${bad.length} row(s) before importing (first: line ${bad[0].line}: ${bad[0].error}).`);
  for (const r of preview) {
    await upsertQuotaResult(tx, {
      ruleId: rule.id,
      driverId: r.driverId!,
      anyDateInPeriod: input.anyDateInPeriod,
      value: r.value!,
      source: "csv",
      note: input.fileName.slice(0, 200),
    });
  }
  return { rows: preview, saved: preview.length };
}

/**
 * Awards the bonus for a quota hit. Owner rule: paid in cash OR credited to the
 * driver's balance (boundary account), chosen per award.
 */
export async function awardBonus(
  tx: Tx,
  input: { quotaResultId: string; mode: "credit" | "cash"; paidOn: IsoDate; reference?: string },
): Promise<string> {
  const [res] = await tx
    .select({ r: quotaResults, rule: quotaRules })
    .from(quotaResults)
    .innerJoin(quotaRules, eq(quotaRules.id, quotaResults.ruleId))
    .where(eq(quotaResults.id, input.quotaResultId));
  if (!res) throw new MoneyRuleError("Result not found.");
  const { r, rule } = res;
  if (!rule.active || rule.bonusCentavos <= BigInt(0)) throw new MoneyRuleError("This quota rule is not active or has no bonus amount.");
  if (r.value < rule.threshold) throw new MoneyRuleError("The driver did not reach the quota.");
  await lockDriver(tx, r.driverId);
  const [existing] = await tx
    .select({ id: bonusAwards.id })
    .from(bonusAwards)
    .where(and(eq(bonusAwards.quotaResultId, r.id), sql`${bonusAwards.voidedAt} IS NULL`));
  if (existing) throw new MoneyRuleError("A bonus was already awarded for this result.");
  const [voided] = await tx.select({ id: bonusAwards.id }).from(bonusAwards).where(eq(bonusAwards.quotaResultId, r.id));
  if (voided) throw new MoneyRuleError("A voided bonus exists for this result; correct the result via a new period entry.");

  let ledgerEntryId: string | null = null;
  if (input.mode === "credit") {
    const [boundary] = await tx
      .select({ id: driverAccounts.id })
      .from(driverAccounts)
      .where(and(eq(driverAccounts.driverId, r.driverId), eq(driverAccounts.kind, "boundary")));
    const accountId = boundary?.id ?? (await ensureAccount(tx, r.driverId, "charges", input.paidOn));
    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        accountId,
        driverId: r.driverId,
        entryType: "bonus_credit",
        amountCentavos: -rule.bonusCentavos,
        businessDate: input.paidOn,
        memo: `Bonus: ${rule.name} (${r.periodStart} – ${r.periodEnd})`,
      })
      .returning({ id: ledgerEntries.id });
    ledgerEntryId = entry.id;
  }
  const [award] = await tx
    .insert(bonusAwards)
    .values({
      quotaResultId: r.id,
      driverId: r.driverId,
      amountCentavos: rule.bonusCentavos,
      payoutMode: input.mode,
      ledgerEntryId,
      paidOn: input.paidOn,
      reference: input.reference ?? "",
    })
    .returning({ id: bonusAwards.id });
  return award.id;
}

/** Voids an award; a balance credit is reversed in the same transaction. */
export async function voidBonus(tx: Tx, input: { awardId: string; reason: string; userId: string; businessDate: IsoDate }): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const [a] = await tx.select().from(bonusAwards).where(eq(bonusAwards.id, input.awardId));
  if (!a) throw new MoneyRuleError("Bonus not found.");
  if (a.voidedAt) throw new MoneyRuleError("This bonus is already void.");
  if (a.ledgerEntryId) {
    await reverseEntry(tx, { entryId: a.ledgerEntryId, reason: `Bonus voided: ${input.reason}`, businessDate: input.businessDate, allowBonus: true });
  }
  await tx
    .update(bonusAwards)
    .set({ voidedAt: new Date(), voidedBy: input.userId, voidReason: input.reason.trim() })
    .where(eq(bonusAwards.id, a.id));
}

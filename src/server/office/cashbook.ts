import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, cashAccounts, cashReassignments, cashReconciliations, cashTransactions, type CashAccountKind, type RoutableMethod } from "@/db/schema";
import { jsonb } from "@/db/sql";
import type { IsoDate } from "@/lib/dates";
import { ZERO, type Centavos } from "@/lib/money";
import { parseSetting, type SettingValue } from "@/lib/settings/registry";
import { MoneyRuleError } from "../money/errors";

/**
 * Cash book writes (owner/admin + finance; RLS enforces it). Manual entries are
 * void-only, reconciliations and reassignments are append-only.
 */

export type ManualCategory = "opening_balance" | "platform_revenue" | "investor_capital" | "owner_capital" | "other_in" | "owner_withdrawal" | "other_out";

export async function recordCashTransaction(
  tx: Tx,
  input: { entryDate: IsoDate; category: ManualCategory; accountId: string; amount: Centavos; description: string; counterparty?: string; reference?: string },
  today: IsoDate,
): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (!input.description.trim()) throw new MoneyRuleError("Describe the entry.");
  if (input.entryDate > today) throw new MoneyRuleError("The date can't be in the future.");
  const [row] = await tx
    .insert(cashTransactions)
    .values({
      entryDate: input.entryDate,
      category: input.category,
      accountId: input.accountId,
      amountCentavos: input.amount,
      description: input.description.trim(),
      counterparty: input.counterparty?.trim() ?? "",
      reference: input.reference?.trim() ?? "",
    })
    .returning({ id: cashTransactions.id });
  return row.id;
}

/** Money moved between two of our own accounts: one record, shown as two legs. */
export async function recordTransfer(
  tx: Tx,
  input: { entryDate: IsoDate; fromAccountId: string; toAccountId: string; amount: Centavos; description?: string; reference?: string },
  today: IsoDate,
): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  if (input.fromAccountId === input.toAccountId) throw new MoneyRuleError("Choose two different accounts.");
  if (input.entryDate > today) throw new MoneyRuleError("The date can't be in the future.");
  const [row] = await tx
    .insert(cashTransactions)
    .values({
      entryDate: input.entryDate,
      category: "transfer",
      accountId: input.fromAccountId,
      counterAccountId: input.toAccountId,
      amountCentavos: input.amount,
      description: input.description?.trim() || "Transfer between accounts",
      reference: input.reference?.trim() ?? "",
    })
    .returning({ id: cashTransactions.id });
  return row.id;
}

export async function voidCashTransaction(tx: Tx, id: string, reason: string, userId: string): Promise<void> {
  if (!reason.trim()) throw new MoneyRuleError("A reason is required.");
  const res = await tx
    .update(cashTransactions)
    .set({ voidedAt: new Date(), voidedBy: userId, voidReason: reason.trim() })
    .where(and(eq(cashTransactions.id, id), isNull(cashTransactions.voidedAt)))
    .returning({ id: cashTransactions.id });
  if (res.length === 0) throw new MoneyRuleError("Entry not found or already void.");
}

/** Records a count. The database stores the book balance for that day alongside it. */
export async function reconcileAccount(
  tx: Tx,
  input: { accountId: string; asOfDate: IsoDate; counted: Centavos; notes?: string },
  today: IsoDate,
): Promise<{ id: string; system: Centavos; variance: Centavos }> {
  if (input.asOfDate > today) throw new MoneyRuleError("You can't reconcile a day that hasn't happened yet.");
  const [row] = await tx
    .insert(cashReconciliations)
    .values({ accountId: input.accountId, asOfDate: input.asOfDate, countedCentavos: input.counted, systemCentavos: ZERO, notes: input.notes?.trim() ?? "" })
    .returning({ id: cashReconciliations.id, system: cashReconciliations.systemCentavos });
  return { id: row.id, system: row.system, variance: input.counted - row.system };
}

/** Moves one module record to another account (e.g. a loan payment actually paid from GCash). */
export async function reassignCashRecord(
  tx: Tx,
  input: { sourceType: (typeof cashReassignments.$inferInsert)["sourceType"]; sourceId: string; accountId: string; reason: string },
): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const [exists] = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.v_cash_book WHERE source_type = ${input.sourceType} AND source_id = ${input.sourceId}::uuid`);
  if (!exists?.n) throw new MoneyRuleError("That record is not in the cash book.");
  await tx.insert(cashReassignments).values({ sourceType: input.sourceType, sourceId: input.sourceId, accountId: input.accountId, reason: input.reason.trim() });
}

/**
 * Creates or edits an account. A payment method belongs to one account only:
 * giving it to this account takes it from the previous one (same transaction).
 */
export async function saveCashAccount(
  tx: Tx,
  input: { id?: string | null; name: string; kind: CashAccountKind; paymentMethod: RoutableMethod | null; active: boolean; sort: number; notes?: string },
): Promise<string> {
  if (!input.name.trim()) throw new MoneyRuleError("Give the account a name.");
  if (input.paymentMethod) {
    await tx
      .update(cashAccounts)
      .set({ paymentMethod: null })
      .where(and(eq(cashAccounts.paymentMethod, input.paymentMethod), input.id ? sql`${cashAccounts.id} <> ${input.id}::uuid` : sql`true`));
  }
  const values = { name: input.name.trim(), kind: input.kind, paymentMethod: input.paymentMethod, active: input.active, sort: input.sort, notes: input.notes?.trim() ?? "" };
  if (input.id) {
    const res = await tx.update(cashAccounts).set(values).where(eq(cashAccounts.id, input.id)).returning({ id: cashAccounts.id });
    if (res.length === 0) throw new MoneyRuleError("Account not found.");
    return res[0].id;
  }
  const [row] = await tx.insert(cashAccounts).values(values).returning({ id: cashAccounts.id });
  return row.id;
}

export type Routing = SettingValue<"cashbook.default_routing">;

/** Saves the default routing (owner/admin only: settings are owner-maintained). */
export async function saveRouting(tx: Tx, routing: Routing): Promise<void> {
  const parsed = parseSetting("cashbook.default_routing", routing);
  const res = await tx
    .update(appSettings)
    .set({ value: jsonb(parsed) })
    .where(eq(appSettings.key, "cashbook.default_routing"))
    .returning({ key: appSettings.key });
  if (res.length === 0) throw new MoneyRuleError("Only the owner/admin can change the routing.");
}

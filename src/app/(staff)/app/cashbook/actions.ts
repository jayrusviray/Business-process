"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { REASSIGNABLE_SOURCES, ROUTABLE_METHODS, CASH_ACCOUNT_KINDS } from "@/db/schema";
import { businessToday } from "@/lib/dates";
import { formatPeso } from "@/lib/money";
import { zIsoDate, zPeso } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import {
  reassignCashRecord,
  recordCashTransaction,
  recordTransfer,
  reconcileAccount,
  saveCashAccount,
  saveRouting,
  voidCashTransaction,
} from "@/server/office/cashbook";

const FIN = ["owner_admin", "finance"] as const;
const zMethod = z.enum(ROUTABLE_METHODS);

export async function recordCashEntryAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        entryDate: zIsoDate,
        category: z.enum(["opening_balance", "platform_revenue", "investor_capital", "owner_capital", "other_in", "owner_withdrawal", "other_out"]),
        accountId: z.guid("Choose an account"),
        amount: zPeso,
        description: z.string().trim().min(2, "Describe the entry").max(300),
        counterparty: z.string().trim().max(120).default(""),
        reference: z.string().trim().max(120).default(""),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => recordCashTransaction(tx, input, businessToday()));
    revalidatePath("/app/cashbook");
    return "Entry recorded.";
  });
}

export async function transferAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        entryDate: zIsoDate,
        fromAccountId: z.guid("Choose the account the money leaves"),
        toAccountId: z.guid("Choose the account the money goes to"),
        amount: zPeso,
        description: z.string().trim().max(300).default(""),
        reference: z.string().trim().max(120).default(""),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => recordTransfer(tx, input, businessToday()));
    revalidatePath("/app/cashbook");
    return "Transfer recorded.";
  });
}

export async function voidCashEntryAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { id, reason } = z.object({ id: z.guid(), reason: z.string().trim().min(3, "Give a reason") }).parse(obj);
    await withUserTx(s.claims, (tx) => voidCashTransaction(tx, id, reason, s.userId));
    revalidatePath("/app/cashbook");
    return "Entry voided.";
  });
}

export async function reconcileAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({ accountId: z.guid("Choose an account"), asOfDate: zIsoDate, counted: zPeso, notes: z.string().trim().max(500).default("") })
      .parse(obj);
    const r = await withUserTx(s.claims, (tx) => reconcileAccount(tx, input, businessToday()));
    revalidatePath("/app/cashbook");
    return r.variance === BigInt(0)
      ? `Reconciled: the count matches the books (${formatPeso(r.system)}).`
      : `Reconciled with a difference of ${formatPeso(r.variance)} (books ${formatPeso(r.system)}).`;
  });
}

export async function reassignAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        sourceType: z.enum(REASSIGNABLE_SOURCES),
        sourceId: z.guid(),
        accountId: z.guid("Choose an account"),
        reason: z.string().trim().min(3, "Give a reason"),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => reassignCashRecord(tx, input));
    revalidatePath("/app/cashbook");
    return "Moved.";
  });
}

export async function saveAccountAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        id: z.union([z.literal(""), z.guid()]).optional(),
        name: z.string().trim().min(2, "Name the account").max(80),
        kind: z.enum(CASH_ACCOUNT_KINDS),
        paymentMethod: z.union([z.literal(""), zMethod]).transform((v) => v || null),
        active: z.string().optional().transform((v) => v === "on"),
        sort: z.coerce.number().int().min(0).max(999).default(100),
        notes: z.string().trim().max(300).default(""),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => saveCashAccount(tx, input));
    revalidatePath("/app/cashbook");
    return "Account saved.";
  });
}

export async function saveRoutingAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin"], async (s) => {
    const routing = z
      .object({
        payroll: zMethod,
        loan_payment: zMethod,
        investor_payout: zMethod,
        commission_payout: zMethod,
        commission_received: zMethod,
        cash_advance: zMethod,
        driver_bonus: zMethod,
        check: zMethod,
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => saveRouting(tx, routing));
    revalidatePath("/app/cashbook");
    return "Routing saved.";
  });
}

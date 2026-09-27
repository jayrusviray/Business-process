"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { recurringExpenses } from "@/db/schema";
import { zIsoDate, zPeso, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { uploadDocument } from "@/server/documents";
import { payRecurring, recordExpense, setBudget, voidExpense } from "@/server/office/expenses";

const FIN = ["owner_admin", "finance"] as const;

export async function recordExpenseAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  const file = formData.get("receipt");
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        categoryId: z.guid("Choose a category"),
        vendor: z.string().trim().max(120).default(""),
        description: z.string().trim().min(2, "Describe the expense").max(300),
        amount: zPeso,
        expenseDate: zIsoDate,
        paidVia: z.enum(["cash", "gcash", "maya", "bank_transfer", "check", "other"]),
        reference: z.string().trim().max(120).default(""),
        vehicleId: z.union([z.literal(""), z.guid()]).transform((v) => v || null),
      })
      .parse(obj);
    await withUserTx(s.claims, async (tx) => {
      const expenseId = crypto.randomUUID();
      const receiptDocumentId =
        file instanceof File && file.size > 0
          ? await uploadDocument(tx, { file, ownerType: "expense", ownerId: expenseId, docType: "expense_receipt", uploadedBy: s.userId })
          : null;
      await recordExpense(tx, { ...input, receiptDocumentId });
    });
    revalidatePath("/app/expenses");
    return "Expense recorded.";
  });
}

export async function voidExpenseAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { id, reason } = z.object({ id: z.guid(), reason: z.string().trim().min(3, "Give a reason") }).parse(obj);
    await withUserTx(s.claims, (tx) => voidExpense(tx, id, reason, s.userId));
    revalidatePath("/app/expenses");
    return "Expense voided.";
  });
}

export async function setBudgetAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { categoryId, month, amount } = z.object({ categoryId: z.guid(), month: zIsoDate, amount: zPesoOrZero }).parse(obj);
    await withUserTx(s.claims, (tx) => setBudget(tx, categoryId, month, amount));
    revalidatePath("/app/expenses");
    return "Budget saved.";
  });
}

export async function payRecurringAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z.object({ recurringId: z.guid(), month: zIsoDate, paidOn: zIsoDate, amount: zPeso, reference: z.string().trim().default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => payRecurring(tx, input));
    revalidatePath("/app/expenses");
    return "Bill recorded.";
  });
}

export async function saveRecurringAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        id: z.union([z.literal(""), z.guid()]).optional(),
        categoryId: z.guid("Choose a category"),
        vendor: z.string().trim().min(2),
        description: z.string().trim().max(200).default(""),
        amount: zPeso,
        dueDay: z.coerce.number().int().min(1).max(31),
        startMonth: zIsoDate,
        active: z.string().optional().transform((v) => v !== "off"),
      })
      .parse(obj);
    const values = { categoryId: input.categoryId, vendor: input.vendor, description: input.description, amountCentavos: input.amount, dueDay: input.dueDay, startMonth: `${input.startMonth.slice(0, 7)}-01`, active: input.active };
    await withUserTx(s.claims, async (tx) => {
      if (input.id) await tx.update(recurringExpenses).set(values).where(eq(recurringExpenses.id, input.id));
      else await tx.insert(recurringExpenses).values(values);
    });
    revalidatePath("/app/expenses");
    return "Recurring bill saved.";
  });
}

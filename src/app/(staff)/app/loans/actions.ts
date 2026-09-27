"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zPeso } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { friendlyError } from "@/server/money/errors";
import { createVehicleLoan, recordLoanPayment, reverseLoanPayment } from "@/server/money/loans";

/** "12" or "10.5" (percent per year) → basis points, without floats. */
const zRateBps = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Enter the annual rate in %, e.g. 10.5")
  .transform((s) => {
    const [w, f = ""] = s.split(".");
    return Number(w) * 100 + Number(f.padEnd(2, "0"));
  });

export async function createLoanAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin", "finance"]);
  const input = z
    .object({
      vehicleId: z.guid("Choose a vehicle"),
      lender: z.string().trim().min(2),
      principal: zPeso,
      annualRate: zRateBps,
      termMonths: z.coerce.number().int().min(1).max(120),
      firstDueDate: zIsoDate,
      notes: z.string().trim().max(1000).default(""),
    })
    .safeParse(formObject(formData));
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Invalid input." };
  let id: string;
  try {
    const { annualRate, ...rest } = input.data;
    id = await withUserTx(session.claims, (tx) => createVehicleLoan(tx, { ...rest, annualRateBps: annualRate }));
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/loans/${id}`);
}

export async function recordLoanPaymentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ loanId: z.guid(), paidOn: zIsoDate, amount: zPeso, reference: z.string().trim().max(120).default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => recordLoanPayment(tx, input));
    revalidatePath(`/app/loans/${input.loanId}`);
    return "Loan payment recorded.";
  });
}

export async function reverseLoanPaymentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ loanId: z.guid(), paymentId: z.guid(), reason: z.string().trim().min(3) }).parse(obj);
    await withUserTx(s.claims, (tx) => reverseLoanPayment(tx, { ...input, today: businessToday() }));
    revalidatePath(`/app/loans/${input.loanId}`);
    return "Payment reversed.";
  });
}

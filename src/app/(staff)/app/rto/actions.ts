"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zPeso, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { friendlyError } from "@/server/money/errors";
import { closePaidContract, createRtoContract, terminateContract } from "@/server/money/rto";

const NewContract = z.object({
  driverId: z.guid("Choose a driver"),
  vehicleId: z.guid("Choose a vehicle"),
  contractPrice: zPeso,
  downPayment: zPesoOrZero,
  termMonths: z.coerce.number().int().min(1).max(120),
  startDate: zIsoDate,
  firstDueDate: zIsoDate,
  paidBeforeGoLive: zPesoOrZero,
  notes: z.string().trim().max(1000).default(""),
});

export async function createContractAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin", "finance"]);
  const input = NewContract.safeParse(formObject(formData));
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Invalid input." };
  let id: string;
  try {
    id = await withUserTx(session.claims, (tx) => createRtoContract(tx, input.data, businessToday()));
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/rto/${id}`);
}

export async function closeContractAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const { contractId } = z.object({ contractId: z.guid() }).parse(obj);
    const result = await withUserTx(s.claims, (tx) => closePaidContract(tx, contractId, businessToday()));
    revalidatePath(`/app/rto/${contractId}`);
    return result === "cashed_out"
      ? "Cashout completed. The vehicle is marked as transferred to the driver. End the driver's boundary plan if it no longer applies."
      : "Contract completed. The vehicle is marked as transferred to the driver.";
  });
}

export async function terminateContractAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const { contractId, reason } = z.object({ contractId: z.guid(), reason: z.string().trim().min(3, "Give a reason") }).parse(obj);
    await withUserTx(s.claims, (tx) => terminateContract(tx, contractId, reason, businessToday()));
    revalidatePath(`/app/rto/${contractId}`);
    return "Contract terminated. Unpaid dues remain on the driver's account.";
  });
}

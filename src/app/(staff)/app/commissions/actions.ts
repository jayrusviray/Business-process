"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zPeso } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import {
  approveReferral,
  createReferralCommission,
  payReferral,
  recordCommissionReceived,
  voidCommissionReceived,
  voidReferral,
} from "@/server/office/commissions";

const FIN = ["owner_admin", "finance"] as const;

export async function createReferralAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        rtoContractId: z.guid("Choose the referred driver's contract"),
        referrerType: z.enum(["driver", "employee", "external"]),
        referrerName: z.string().trim().min(2),
        referrerPhone: z.string().trim().max(20).default(""),
        referrerDriverId: z.union([z.literal(""), z.guid()]).transform((v) => v || null),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => createReferralCommission(tx, input));
    revalidatePath("/app/commissions");
    return "Referral commission recorded.";
  });
}

export async function referralStepAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { id, step, reference, reason } = z
      .object({ id: z.guid(), step: z.enum(["approve", "pay", "void"]), reference: z.string().trim().default(""), reason: z.string().trim().default("") })
      .parse(obj);
    await withUserTx(s.claims, async (tx) => {
      if (step === "approve") await approveReferral(tx, id, s.userId, businessToday());
      if (step === "pay") await payReferral(tx, id, businessToday(), reference);
      if (step === "void") await voidReferral(tx, id, reason);
    });
    revalidatePath("/app/commissions");
    return step === "approve" ? "Approved." : step === "pay" ? "Marked as paid." : "Voided.";
  });
}

export async function recordReceivedAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({
        sourceType: z.enum(["platform", "dealer", "other"]),
        counterparty: z.string().trim().min(2),
        description: z.string().trim().min(2),
        amount: zPeso,
        receivedOn: zIsoDate,
        reference: z.string().trim().default(""),
        vehicleId: z.union([z.literal(""), z.guid()]).transform((v) => v || null),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => recordCommissionReceived(tx, input));
    revalidatePath("/app/commissions");
    return "Commission received recorded.";
  });
}

export async function voidReceivedAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { id, reason } = z.object({ id: z.guid(), reason: z.string().trim().min(3) }).parse(obj);
    await withUserTx(s.claims, (tx) => voidCommissionReceived(tx, id, reason, s.userId));
    revalidatePath("/app/commissions");
    return "Voided.";
  });
}

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { investors } from "@/db/schema";
import { businessToday, isoDate } from "@/lib/dates";
import { formObject, guarded, type ActionState } from "@/server/action";
import { generateInvestorPayouts, markInvestorPayoutPaid, setVehicleInvestor } from "@/server/office/investors";

const FIN = ["owner_admin", "finance"] as const;

export async function saveInvestorAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const input = z
      .object({ name: z.string().trim().min(2), phone: z.string().trim().max(20).default(""), email: z.union([z.literal(""), z.email()]).transform((v) => v || null), notes: z.string().trim().max(500).default("") })
      .parse(obj);
    await withUserTx(s.claims, async (tx) => {
      if (obj.id) await tx.update(investors).set(input).where(eq(investors.id, z.guid().parse(obj.id)));
      else await tx.insert(investors).values(input);
    });
    revalidatePath("/app/investors");
    return "Investor saved.";
  });
}

export async function assignVehicleAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { vehicleId, investorId } = z.object({ vehicleId: z.guid(), investorId: z.union([z.literal(""), z.guid()]) }).parse(obj);
    await withUserTx(s.claims, (tx) => setVehicleInvestor(tx, vehicleId, investorId || null));
    revalidatePath("/app/investors");
    return "Vehicle updated.";
  });
}

export async function generatePayoutsAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(obj);
    const r = await withUserTx(s.claims, (tx) => generateInvestorPayouts(tx, isoDate(`${month}-01`)));
    revalidatePath("/app/investors");
    return `Computed ${month}.${r.negative ? ` ${r.negative} vehicle(s) came out negative and are set to ₱0.00: review them.` : ""}`;
  });
}

export async function payPayoutAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(FIN, async (s) => {
    const { id, reference } = z.object({ id: z.guid(), reference: z.string().trim().default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => markInvestorPayoutPaid(tx, id, businessToday(), reference));
    revalidatePath("/app/investors");
    return "Marked as paid.";
  });
}

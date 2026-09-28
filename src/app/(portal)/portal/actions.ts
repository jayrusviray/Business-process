"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { drivers } from "@/db/schema";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zPeso } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { uploadDocument } from "@/server/documents";
import { MoneyRuleError } from "@/server/money/errors";
import { submitProof } from "@/server/money/proofs";

const ProofInput = z.object({
  amount: zPeso,
  method: z.enum(["gcash", "maya", "bank_transfer", "other"]),
  referenceNo: z.string().trim().min(1, "Enter the reference number.").max(80),
  paidOn: zIsoDate,
  note: z.string().trim().max(300).default(""),
});

/** Driver portal: send a GCash/Maya/bank screenshot for finance to verify. */
export async function submitProofAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["driver"], async (session) => {
    const parsed = ProofInput.safeParse(obj);
    if (!parsed.success) throw new MoneyRuleError(parsed.error.issues[0]?.message ?? "Check the form.");
    const file = formData.get("proof");
    if (!(file instanceof File) || file.size === 0) throw new MoneyRuleError("Attach the screenshot of your payment.");
    await withUserTx(session.claims, async (tx) => {
      const [me] = await tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.profileId, session.userId));
      if (!me) throw new MoneyRuleError("Your login is not linked to a driver record.");
      const id = crypto.randomUUID();
      const documentId = await uploadDocument(tx, { file, ownerType: "payment_proof", ownerId: id, docType: "payment_proof", uploadedBy: session.userId });
      await submitProof(tx, { ...parsed.data, id, driverId: me.id, documentId, submittedBy: session.userId, today: businessToday() });
    });
    revalidatePath("/portal");
    return "Sent! We'll check it and update your balance. Salamat!";
  });
}

"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { drivers } from "@/db/schema";
import { businessToday } from "@/lib/dates";
import { zIsoDate, zOptionalText, zPeso, zPhMobile } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { friendlyError } from "@/server/money/errors";
import { assignVehicle, endBoundaryPlan, startBoundaryPlan, unassignVehicle } from "@/server/money/fleet";
import { postAdjustment, postDriverCharge, reverseEntry } from "@/server/money/payments";
import { requireRole } from "@/lib/auth/session";

const A = "owner_admin" as const;
const F = "finance" as const;
const O = "operations" as const;

const DriverInput = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().min(1, "Last name is required").max(80),
  phone: zPhMobile,
  email: z.union([z.literal(""), z.email()]).transform((s) => s || null),
  address: z.string().trim().max(300).default(""),
  birthdate: z.union([z.literal(""), zIsoDate]).transform((s) => s || null),
  licenseNo: zOptionalText,
  licenseExpiry: z.union([z.literal(""), zIsoDate]).transform((s) => s || null),
  emergencyContactName: z.string().trim().max(120).default(""),
  emergencyContactPhone: z.string().trim().max(40).default(""),
  status: z.enum(["applicant", "active", "suspended", "completed", "terminated"]),
  notes: z.string().trim().max(2000).default(""),
});

export async function createDriver(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole([A, F, O]);
  const input = DriverInput.safeParse(formObject(formData));
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Invalid input." };
  let id: string;
  try {
    [{ id }] = await withUserTx(session.claims, (tx) =>
      tx.insert(drivers).values(input.data).returning({ id: drivers.id }),
    );
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/drivers/${id}`);
}

export async function updateDriver(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, F, O], async (s) => {
    const id = z.guid().parse(obj.id);
    const data = DriverInput.parse(obj);
    await withUserTx(s.claims, (tx) => tx.update(drivers).set(data).where(eq(drivers.id, id)));
    revalidatePath(`/app/drivers/${id}`);
    return "Driver saved.";
  });
}

export async function startPlanAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, F, O], async (s) => {
    const input = z
      .object({ driverId: z.guid(), programType: z.enum(["boundary", "rto"]), dailyRate: zPeso, effectiveFrom: zIsoDate, notes: z.string().default("") })
      .parse(obj);
    await withUserTx(s.claims, (tx) => startBoundaryPlan(tx, input, businessToday()));
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Boundary plan saved.";
  });
}

export async function endPlanAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, F, O], async (s) => {
    const input = z.object({ driverId: z.guid(), lastDay: zIsoDate }).parse(obj);
    await withUserTx(s.claims, (tx) => endBoundaryPlan(tx, input.driverId, input.lastDay));
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Plan ended.";
  });
}

export async function assignVehicleAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, O], async (s) => {
    const input = z.object({ driverId: z.guid(), vehicleId: z.guid(), startDate: zIsoDate, reason: z.string().default("") }).parse(obj);
    await withUserTx(s.claims, (tx) => assignVehicle(tx, input));
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Vehicle assigned.";
  });
}

export async function unassignVehicleAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, O], async (s) => {
    const input = z.object({ driverId: z.guid(), lastDay: zIsoDate }).parse(obj);
    await withUserTx(s.claims, (tx) => unassignVehicle(tx, input.driverId, input.lastDay));
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Vehicle returned.";
  });
}

export async function postDriverChargeAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, F, O], async (s) => {
    const input = z
      .object({ driverId: z.guid(), kind: z.enum(["cost_charge", "deposit_charge"]), amount: zPeso, dueDate: zIsoDate, memo: z.string().trim().min(1, "Describe the charge") })
      .parse(obj);
    await withUserTx(s.claims, (tx) => postDriverCharge(tx, input));
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Charge posted.";
  });
}

export async function adjustmentAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, F], async (s) => {
    const input = z
      .object({
        driverId: z.guid(),
        accountId: z.guid(),
        direction: z.enum(["debit", "credit"]),
        type: z.enum(["adjustment", "opening_balance"]),
        amount: zPeso,
        dueDate: zIsoDate,
        reason: z.string().trim().min(3, "Give a reason"),
      })
      .parse(obj);
    if (input.amount <= BigInt(0)) throw new Error("Enter a positive amount and choose debit or credit.");
    await withUserTx(s.claims, (tx) =>
      postAdjustment(tx, {
        accountId: input.accountId,
        amount: input.direction === "debit" ? input.amount : -input.amount,
        reason: input.reason,
        businessDate: businessToday(),
        dueDate: input.dueDate,
        type: input.type,
      }),
    );
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Adjustment posted.";
  });
}

export async function reverseEntryAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded([A, F], async (s) => {
    const input = z.object({ driverId: z.guid(), entryId: z.guid(), reason: z.string().trim().min(3, "Give a reason") }).parse(obj);
    await withUserTx(s.claims, (tx) => reverseEntry(tx, { entryId: input.entryId, reason: input.reason, businessDate: businessToday() }));
    revalidatePath(`/app/drivers/${input.driverId}`);
    return "Entry reversed.";
  });
}

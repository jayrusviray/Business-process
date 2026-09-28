"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { franchises, vehicles } from "@/db/schema";
import { requireRole } from "@/lib/auth/session";
import { zIsoDate, zPesoOrZero } from "@/lib/validation";
import { formObject, guarded, type ActionState } from "@/server/action";
import { hasAnyRole } from "@/lib/auth/roles";
import { businessToday } from "@/lib/dates";
import { uploadDocument } from "@/server/documents";
import { friendlyError, MoneyRuleError } from "@/server/money/errors";
import { recordMaintenance, voidMaintenance } from "@/server/money/maintenance";

const VehicleInput = z.object({
  plateNo: z.string().trim().min(2, "Plate number is required").max(20).transform((s) => s.toUpperCase()),
  make: z.string().trim().min(1, "Make is required").max(60),
  model: z.string().trim().min(1, "Model is required").max(60),
  year: z.union([z.literal(""), z.coerce.number().int().min(1990).max(2100)]).transform((v) => (v === "" ? null : v)),
  color: z.string().trim().max(40).default(""),
  powertrain: z.enum(["ice", "ev", "hybrid"]).default("ice"),
  conductionSticker: z.string().trim().max(40).default(""),
  orcrExpiresOn: z.union([z.literal(""), zIsoDate]).transform((s) => s || null),
  insuranceExpiresOn: z.union([z.literal(""), zIsoDate]).transform((s) => s || null),
  region: z.string().trim().max(80).default(""),
  platforms: z.string().default("").transform((s) => s.split(",").map((p) => p.trim()).filter(Boolean)),
  acquisitionCost: zPesoOrZero,
  acquiredOn: z.union([z.literal(""), zIsoDate]).transform((s) => s || null),
  fundingSource: z.enum(["company", "investor", "financed"]),
  status: z.enum(["available", "assigned", "maintenance", "transferred", "retired"]).default("available"),
  notes: z.string().trim().max(2000).default(""),
});

function toRow(v: z.infer<typeof VehicleInput>) {
  const { acquisitionCost, ...rest } = v;
  return { ...rest, acquisitionCostCentavos: acquisitionCost > BigInt(0) ? acquisitionCost : null };
}

export async function createVehicle(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin", "operations"]);
  const input = VehicleInput.safeParse(formObject(formData));
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Invalid input." };
  let id: string;
  try {
    [{ id }] = await withUserTx(session.claims, (tx) => tx.insert(vehicles).values(toRow(input.data)).returning({ id: vehicles.id }));
  } catch (e) {
    return { error: friendlyError(e) };
  }
  redirect(`/app/vehicles/${id}`);
}

export async function updateVehicle(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "operations"], async (s) => {
    const id = z.guid().parse(obj.id);
    const data = VehicleInput.parse(obj);
    await withUserTx(s.claims, (tx) => tx.update(vehicles).set(toRow(data)).where(eq(vehicles.id, id)));
    revalidatePath(`/app/vehicles/${id}`);
    return "Vehicle saved.";
  });
}

export async function addFranchise(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "operations"], async (s) => {
    const input = z
      .object({
        vehicleId: z.guid(),
        operatorName: z.string().trim().min(1),
        clientId: z.union([z.literal(""), z.guid()]).optional().transform((v) => v || null),
        kind: z.enum(["PA", "CPC"]),
        number: z.string().trim().min(1),
        issuedOn: z.union([z.literal(""), zIsoDate]).transform((v) => v || null),
        expiresOn: z.union([z.literal(""), zIsoDate]).transform((v) => v || null),
      })
      .parse(obj);
    await withUserTx(s.claims, (tx) => tx.insert(franchises).values(input));
    revalidatePath(`/app/vehicles/${input.vehicleId}`);
    return "Franchise added.";
  });
}

const MaintenanceInput = z.object({
  vehicleId: z.guid(),
  serviceDate: zIsoDate,
  description: z.string().trim().min(2, "Describe the work done").max(200),
  shop: z.string().trim().max(120).default(""),
  odometerKm: z.union([z.literal(""), z.coerce.number().int().min(0).max(5_000_000)]).transform((v) => (v === "" ? null : v)),
  cost: zPesoOrZero,
  bookExpense: z.string().optional().transform((v) => v === "on"),
  chargeDriverId: z.union([z.literal(""), z.guid()]).transform((v) => v || null),
});

/** Logs a service/repair; optionally books the expense and charges the driver at cost. */
export async function addMaintenanceAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance", "operations"], async (s) => {
    const parsed = MaintenanceInput.safeParse(obj);
    if (!parsed.success) throw new MoneyRuleError(parsed.error.issues[0]?.message ?? "Check the form.");
    const m = parsed.data;
    if (m.bookExpense && !hasAnyRole(s.roles, ["owner_admin", "finance"])) {
      throw new MoneyRuleError("Only owner/admin and finance can book company expenses. Untick it, or ask finance.");
    }
    const file = formData.get("receipt");
    await withUserTx(s.claims, async (tx) => {
      const receiptDocumentId =
        file instanceof File && file.size > 0
          ? await uploadDocument(tx, { file, ownerType: "vehicle", ownerId: m.vehicleId, docType: "maintenance_receipt", uploadedBy: s.userId })
          : null;
      await recordMaintenance(tx, { ...m, receiptDocumentId, today: businessToday() });
    });
    revalidatePath(`/app/vehicles/${m.vehicleId}`);
    return m.chargeDriverId ? "Maintenance logged and charged to the driver." : "Maintenance logged.";
  });
}

export async function voidMaintenanceAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(["owner_admin", "finance"], async (s) => {
    const input = z.object({ id: z.guid(), vehicleId: z.guid(), reason: z.string().trim().min(3, "Give a reason").max(300) }).safeParse(obj);
    if (!input.success) throw new MoneyRuleError(input.error.issues[0].message);
    await withUserTx(s.claims, (tx) => voidMaintenance(tx, { id: input.data.id, reason: input.data.reason, userId: s.userId, today: businessToday() }));
    revalidatePath(`/app/vehicles/${input.data.vehicleId}`);
    return "Voided. The expense and the driver charge were reversed.";
  });
}

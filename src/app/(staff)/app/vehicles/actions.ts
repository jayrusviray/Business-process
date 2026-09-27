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
import { friendlyError } from "@/server/money/errors";

const VehicleInput = z.object({
  plateNo: z.string().trim().min(2, "Plate number is required").max(20).transform((s) => s.toUpperCase()),
  make: z.string().trim().min(1, "Make is required").max(60),
  model: z.string().trim().min(1, "Model is required").max(60),
  year: z.union([z.literal(""), z.coerce.number().int().min(1990).max(2100)]).transform((v) => (v === "" ? null : v)),
  color: z.string().trim().max(40).default(""),
  isEv: z.string().optional().transform((v) => v === "on"),
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

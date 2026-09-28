import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { expenseCategories, vehicleMaintenance } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { ZERO, type Centavos } from "@/lib/money";
import { recordExpense, voidExpense } from "../office/expenses";
import { MoneyRuleError } from "./errors";
import { postDriverCharge, reverseEntry } from "./payments";

export type NewMaintenance = {
  vehicleId: string;
  serviceDate: IsoDate;
  description: string;
  shop?: string;
  odometerKm?: number | null;
  cost: Centavos;
  receiptDocumentId?: string | null;
  /** Book the cost as a company expense ("Vehicle maintenance"). Owner/admin and finance only. */
  bookExpense: boolean;
  /** Charge the cost to this driver at cost (owner rule: drivers bear all costs). */
  chargeDriverId?: string | null;
  today: IsoDate;
};

/** Logs a service/repair and, optionally, the expense and the driver charge, in one transaction. */
export async function recordMaintenance(tx: Tx, m: NewMaintenance): Promise<string> {
  if (!m.description.trim()) throw new MoneyRuleError("Describe the work done.");
  if (m.serviceDate > m.today) throw new MoneyRuleError("The service date can't be in the future.");
  if (m.cost < ZERO) throw new MoneyRuleError("Cost can't be negative.");
  if ((m.bookExpense || m.chargeDriverId) && m.cost === ZERO) {
    throw new MoneyRuleError("Enter the cost to book an expense or charge the driver.");
  }
  let expenseId: string | null = null;
  if (m.bookExpense) {
    const [cat] = await tx.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.name, "Vehicle maintenance"));
    if (!cat) throw new MoneyRuleError('The "Vehicle maintenance" expense category is missing.');
    expenseId = await recordExpense(tx, {
      categoryId: cat.id,
      vendor: m.shop,
      description: m.description,
      amount: m.cost,
      expenseDate: m.serviceDate,
      vehicleId: m.vehicleId,
      receiptDocumentId: m.receiptDocumentId ?? null,
    });
  }
  const ledgerEntryId = m.chargeDriverId
    ? await postDriverCharge(tx, {
        driverId: m.chargeDriverId,
        kind: "cost_charge",
        amount: m.cost,
        dueDate: m.serviceDate,
        memo: `Maintenance: ${m.description.trim()}${m.shop?.trim() ? ` (${m.shop.trim()})` : ""}`.slice(0, 200),
      })
    : null;
  const [row] = await tx
    .insert(vehicleMaintenance)
    .values({
      vehicleId: m.vehicleId,
      serviceDate: m.serviceDate,
      description: m.description.trim(),
      shop: m.shop?.trim() ?? "",
      odometerKm: m.odometerKm ?? null,
      costCentavos: m.cost,
      receiptDocumentId: m.receiptDocumentId ?? null,
      expenseId,
      driverId: m.chargeDriverId ?? null,
      ledgerEntryId,
    })
    .returning({ id: vehicleMaintenance.id });
  return row.id;
}

/** Voids the record, its expense and its driver charge (reversal entry) together. */
export async function voidMaintenance(tx: Tx, input: { id: string; reason: string; userId: string; today: IsoDate }): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new MoneyRuleError("A reason is required.");
  const [m] = await tx.select().from(vehicleMaintenance).where(eq(vehicleMaintenance.id, input.id));
  if (!m) throw new MoneyRuleError("Maintenance record not found.");
  if (m.voidedAt) throw new MoneyRuleError("This record is already void.");
  await tx.update(vehicleMaintenance).set({ voidedAt: new Date(), voidedBy: input.userId, voidReason: reason }).where(eq(vehicleMaintenance.id, m.id));
  if (m.expenseId) await voidExpense(tx, m.expenseId, `Maintenance voided: ${reason}`, input.userId);
  if (m.ledgerEntryId) await reverseEntry(tx, { entryId: m.ledgerEntryId, reason: `Maintenance voided: ${reason}`, businessDate: input.today });
}

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDate } from "@/lib/dates";
import { pesos } from "@/lib/money";
import { postBoundaryCharges } from "@/server/money/charges";
import { closeDay, getDayView } from "@/server/money/day-close";
import { ensureAccount, startBoundaryPlan } from "@/server/money/fleet";
import { recordMaintenance, voidMaintenance } from "@/server/money/maintenance";
import { createRemittance, recordPayment } from "@/server/money/payments";
import { approveProof, rejectProof, submitProof } from "@/server/money/proofs";
import { renderReceiptPdf } from "@/server/pdf/receipt";
import { driverAlerts } from "@/server/queries/driver-alerts";
import { listDrivers } from "@/server/queries/drivers";
import { as, schema, withSystemTx, withUserTx } from "./app";
import { createUser, expectDbError, sql } from "./helpers";

const { drivers, vehicles, documents, paymentProofs, driverPlatformAccounts, collectionDayCloses } = schema;
const D = isoDate;
const TODAY = D("2026-10-20");

let finance: string, ops: string, driverUser: string, otherDriverUser: string;
let driverId: string, otherDriverId: string, boundaryAcct: string, chargesAcct: string;

async function newDriver(profileId?: string) {
  return withUserTx(as(ops), async (tx) => {
    const [d] = await tx
      .insert(drivers)
      .values({ firstName: "Ops", lastName: `Driver ${crypto.randomUUID().slice(0, 6)}`, phone: "09170001111", status: "active", profileId })
      .returning({ id: drivers.id });
    return d.id;
  });
}

async function newVehicle() {
  return withUserTx(as(ops), async (tx) => {
    const [v] = await tx.insert(vehicles).values({ plateNo: `OPS ${Math.floor(Math.random() * 1e6)}`, make: "Toyota", model: "Vios" }).returning({ id: vehicles.id });
    return v.id;
  });
}

/** Uploads a proof file record + the proof, as the driver (storage itself is not exercised here). */
async function submitAsDriver(user: string, forDriver: string, amount = pesos(700)) {
  return withUserTx(as(user), async (tx) => {
    const id = crypto.randomUUID();
    const [doc] = await tx
      .insert(documents)
      .values({ ownerType: "payment_proof", ownerId: id, docType: "payment_proof", storagePath: `payment_proof/${id}/x.jpg`, fileName: "x.jpg", mimeType: "image/jpeg", sizeBytes: 10, uploadedBy: user })
      .returning({ id: documents.id });
    return submitProof(tx, { id, driverId: forDriver, amount, method: "gcash", referenceNo: "GC123", paidOn: D("2026-10-19"), documentId: doc.id, submittedBy: user, today: TODAY });
  });
}

async function balance(accountId: string) {
  const [r] = await sql`SELECT balance_centavos FROM public.v_account_balances WHERE account_id = ${accountId}`;
  return BigInt(r.balance_centavos);
}

beforeAll(async () => {
  finance = await createUser("O Finance", ["finance"]);
  ops = await createUser("O Ops", ["operations"]);
  driverUser = await createUser("O Driver", ["driver"]);
  otherDriverUser = await createUser("O Other", ["driver"]);
  driverId = await newDriver(driverUser);
  otherDriverId = await newDriver(otherDriverUser);
  boundaryAcct = await withUserTx(as(ops), (tx) => ensureAccount(tx, driverId, "boundary", D("2026-10-01")));
  chargesAcct = await withUserTx(as(ops), (tx) => ensureAccount(tx, driverId, "charges", D("2026-10-01")));
  // Something owed, so the approval has an account to credit.
  await sql`INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date, reason)
    VALUES (${boundaryAcct}, ${driverId}, 'opening_balance', 150000, '2026-10-01', '2026-10-01', 'test opening')`;
});

afterAll(async () => {
  await sql.end();
});

describe("payment proofs", () => {
  it("a driver submits a proof for themselves only; other drivers can't see it", async () => {
    const id = await submitAsDriver(driverUser, driverId);
    await expectDbError(submitAsDriver(driverUser, otherDriverId), /row-level security/);
    const seenByOther = await withUserTx(as(otherDriverUser), (tx) => tx.select().from(paymentProofs).where(eq(paymentProofs.id, id)));
    expect(seenByOther).toEqual([]);
    const seenByOwner = await withUserTx(as(driverUser), (tx) => tx.select().from(paymentProofs).where(eq(paymentProofs.id, id)));
    expect(seenByOwner[0]).toMatchObject({ status: "pending", amountCentavos: pesos(700) });
  });

  it("the proof file must be the submitter's own upload for that proof", async () => {
    await expectDbError(
      withUserTx(as(driverUser), async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values({ ownerType: "payment_proof", ownerId: crypto.randomUUID(), docType: "payment_proof", storagePath: `p/${crypto.randomUUID()}`, fileName: "x", mimeType: "image/png", sizeBytes: 1, uploadedBy: driverUser })
          .returning({ id: documents.id });
        return submitProof(tx, { id: crypto.randomUUID(), driverId, amount: pesos(1), method: "maya", referenceNo: "M1", paidOn: TODAY, documentId: doc.id, submittedBy: driverUser, today: TODAY });
      }),
      /uploaded by the submitter/,
    );
  });

  it("finance approves with an exact split: a payment is posted once, dated the day the driver paid", async () => {
    const id = await submitAsDriver(driverUser, driverId, pesos(1000));
    // Operations can see but not decide.
    await expectDbError(
      withUserTx(as(ops), (tx) => approveProof(tx, { proofId: id, lines: [{ accountId: boundaryAcct, amount: pesos(1000) }], decidedBy: ops })),
      /not allowed to verify/,
    );
    // Nothing was posted by the refused attempt.
    const [n] = await sql`SELECT count(*)::int AS n FROM public.payments WHERE client_request_id = ${id}`;
    expect(n.n).toBe(0);
    await expectDbError(
      withUserTx(as(finance), (tx) => approveProof(tx, { proofId: id, lines: [{ accountId: boundaryAcct, amount: pesos(900) }], decidedBy: finance })),
      /add up exactly/,
    );
    const before = await balance(boundaryAcct);
    const res = await withUserTx(as(finance), (tx) =>
      approveProof(tx, { proofId: id, lines: [{ accountId: boundaryAcct, amount: pesos(600) }, { accountId: chargesAcct, amount: pesos(400) }], decidedBy: finance }),
    );
    expect(await balance(boundaryAcct)).toBe(before - pesos(600));
    const [p] = await sql`SELECT business_date::text, method, reference_no, client_request_id FROM public.payments WHERE id = ${res.paymentId}`;
    expect(p).toEqual({ business_date: "2026-10-19", method: "gcash", reference_no: "GC123", client_request_id: id });
    const [proof] = await sql`SELECT status, payment_id, decided_by FROM public.payment_proofs WHERE id = ${id}`;
    expect(proof).toEqual({ status: "approved", payment_id: res.paymentId, decided_by: finance });
    await expectDbError(
      withUserTx(as(finance), (tx) => approveProof(tx, { proofId: id, lines: [{ accountId: boundaryAcct, amount: pesos(1000) }], decidedBy: finance })),
      /already decided/,
    );
    await expectDbError(sql`DELETE FROM public.payment_proofs WHERE id = ${id}`, /append-only/);

    // The acknowledgement receipt PDF: the driver gets their own, nobody else's.
    const own = await withUserTx(as(driverUser), (tx) => renderReceiptPdf(tx, res.paymentId));
    expect(own?.receiptNo).toBe(res.receiptNo);
    expect(own?.pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(await withUserTx(as(otherDriverUser), (tx) => renderReceiptPdf(tx, res.paymentId))).toBeNull();
  });

  it("an approval must point at a payment of the same amount and driver", async () => {
    const id = await submitAsDriver(driverUser, driverId, pesos(50));
    const other = await withUserTx(as(finance), (tx) =>
      recordPayment(tx, { clientRequestId: crypto.randomUUID(), driverId, method: "cash", receivedAt: new Date(), businessDate: TODAY, collectorId: finance, lines: [{ accountId: boundaryAcct, amount: pesos(51) }] }),
    );
    await expectDbError(
      withUserTx(as(finance), (tx) =>
        tx.update(paymentProofs).set({ status: "approved", decidedBy: finance, decidedAt: new Date(), paymentId: other.id }).where(eq(paymentProofs.id, id)),
      ),
      /must match/,
    );
  });

  it("rejection needs a reason; the driver can't change a proof", async () => {
    const id = await submitAsDriver(driverUser, driverId);
    const changed = await withUserTx(as(driverUser), (tx) =>
      tx.update(paymentProofs).set({ amountCentavos: pesos(1) }).where(eq(paymentProofs.id, id)).returning(),
    ).catch((e) => e);
    expect(changed instanceof Error || (Array.isArray(changed) && changed.length === 0)).toBe(true);
    await expectDbError(withUserTx(as(finance), (tx) => rejectProof(tx, { proofId: id, reason: " ", decidedBy: finance })), /reason/);
    await withUserTx(as(finance), (tx) => rejectProof(tx, { proofId: id, reason: "Reference not found in GCash", decidedBy: finance }));
    const [r] = await sql`SELECT status, reject_reason FROM public.payment_proofs WHERE id = ${id}`;
    expect(r).toEqual({ status: "rejected", reject_reason: "Reference not found in GCash" });
  });

  it("limits how many proofs can wait for verification", async () => {
    const d = await newDriver();
    const u = await createUser("O Flood", ["driver"]);
    await sql`UPDATE public.drivers SET profile_id = ${u} WHERE id = ${d}`;
    for (let i = 0; i < 5; i++) await submitAsDriver(u, d);
    await expectDbError(submitAsDriver(u, d), /too many payment proofs/);
  });
});

describe("daily collection close", () => {
  const DAY = D("2025-02-14");
  it("snapshots per-collector totals once; the snapshot is immutable", async () => {
    const d = await newDriver();
    const acct = await withUserTx(as(ops), (tx) => ensureAccount(tx, d, "boundary", DAY));
    const pay = (collector: string, method: "cash" | "gcash", amount: number) =>
      withUserTx(as(ops), (tx) =>
        recordPayment(tx, { clientRequestId: crypto.randomUUID(), driverId: d, method, referenceNo: method === "cash" ? null : "R1", receivedAt: new Date(), businessDate: DAY, collectorId: collector, lines: [{ accountId: acct, amount: pesos(amount) }] }),
      );
    const a = await pay(ops, "cash", 700);
    await pay(ops, "cash", 300);
    await pay(finance, "gcash", 500);
    await withUserTx(as(finance), (tx) => createRemittance(tx, { collectorId: ops, paymentIds: [a.id], remitted: pesos(700), businessDate: DAY, receivedBy: finance }));

    const v = await withUserTx(as(finance), (tx) => getDayView(tx, DAY));
    expect([v.collected, v.cash, v.remitted, v.unremitted]).toEqual([pesos(1500), pesos(1000), pesos(700), pesos(300)]);
    await expectDbError(withUserTx(as(ops), (tx) => closeDay(tx, { date: DAY, today: TODAY, closedBy: ops })), /row-level security/);
    await expectDbError(withUserTx(as(finance), (tx) => closeDay(tx, { date: D("2026-12-01"), today: TODAY, closedBy: finance })), /hasn't happened/);
    await withUserTx(as(finance), (tx) => closeDay(tx, { date: DAY, today: TODAY, closedBy: finance, notes: "ok" }));
    const [c] = await withUserTx(as(ops), (tx) => tx.select().from(collectionDayCloses).where(eq(collectionDayCloses.businessDate, DAY)));
    expect(c).toMatchObject({ collectedCentavos: pesos(1500), cashCentavos: pesos(1000), remittedCentavos: pesos(700), closedBy: finance });
    expect((c.collectors as { name: string; unremitted: string }[]).find((x) => x.name === "O Ops")?.unremitted).toBe("30000");
    await expectDbError(withUserTx(as(finance), (tx) => closeDay(tx, { date: DAY, today: TODAY, closedBy: finance })), /already closed/);
    await expectDbError(sql`UPDATE public.collection_day_closes SET notes = 'x' WHERE business_date = ${DAY}`, /append-only/);
  });
});

describe("vehicle maintenance", () => {
  it("operations logs a repair charged to the driver at cost, but can't book company expenses", async () => {
    const v = await newVehicle();
    const d = await newDriver();
    await expectDbError(
      withUserTx(as(ops), (tx) => recordMaintenance(tx, { vehicleId: v, serviceDate: TODAY, description: "Change oil", cost: pesos(1500), bookExpense: true, today: TODAY })),
      /category is missing|row-level security/,
    );
    const id = await withUserTx(as(ops), (tx) =>
      recordMaintenance(tx, { vehicleId: v, serviceDate: TODAY, description: "Change oil", shop: "Shop A", odometerKm: 12000, cost: pesos(1500), bookExpense: false, chargeDriverId: d, today: TODAY }),
    );
    const [row] = await sql`SELECT m.driver_id, e.entry_type, e.amount_centavos, e.memo FROM public.vehicle_maintenance m JOIN public.ledger_entries e ON e.id = m.ledger_entry_id WHERE m.id = ${id}`;
    expect(row).toEqual({ driver_id: d, entry_type: "cost_charge", amount_centavos: "150000", memo: "Maintenance: Change oil (Shop A)" });
    await expectDbError(
      withUserTx(as(ops), (tx) => voidMaintenance(tx, { id, reason: "wrong", userId: ops, today: TODAY })),
      /row-level security|not found|already/,
    );
  });

  it("finance books the expense and the charge; voiding undoes both", async () => {
    const v = await newVehicle();
    const d = await newDriver();
    const id = await withUserTx(as(finance), (tx) =>
      recordMaintenance(tx, { vehicleId: v, serviceDate: TODAY, description: "Brake pads", cost: pesos(2500), bookExpense: true, chargeDriverId: d, today: TODAY }),
    );
    const [e] = await sql`SELECT x.vehicle_id, x.amount_centavos, c.name FROM public.vehicle_maintenance m JOIN public.expenses x ON x.id = m.expense_id JOIN public.expense_categories c ON c.id = x.category_id WHERE m.id = ${id}`;
    expect(e).toEqual({ vehicle_id: v, amount_centavos: "250000", name: "Vehicle maintenance" });
    const [before] = await sql`SELECT SUM(amount_centavos)::text s FROM public.ledger_entries WHERE driver_id = ${d}`;
    expect(before.s).toBe("250000");
    await withUserTx(as(finance), (tx) => voidMaintenance(tx, { id, reason: "Warranty covered it", userId: finance, today: TODAY }));
    const [after] = await sql`SELECT SUM(amount_centavos)::text s FROM public.ledger_entries WHERE driver_id = ${d}`;
    expect(after.s).toBe("0");
    const [x] = await sql`SELECT m.void_reason, x.voided_at IS NOT NULL AS expense_void FROM public.vehicle_maintenance m JOIN public.expenses x ON x.id = m.expense_id WHERE m.id = ${id}`;
    expect(x).toEqual({ void_reason: "Warranty covered it", expense_void: true });
    await expectDbError(sql`UPDATE public.vehicle_maintenance SET cost_centavos = 1 WHERE id = ${id}`, /already void/);
  });

  it("a linked charge must match the record's driver and cost", async () => {
    const v = await newVehicle();
    await expectDbError(
      withUserTx(as(finance), async (tx) => {
        const [e] = await sql`SELECT id FROM public.ledger_entries WHERE entry_type = 'cost_charge' LIMIT 1`;
        return tx.insert(schema.vehicleMaintenance).values({ vehicleId: v, serviceDate: TODAY, description: "x", costCentavos: pesos(1), driverId: driverId, ledgerEntryId: e.id });
      }),
      /must be a cost charge/,
    );
  });
});

describe("driver platform accounts", () => {
  it("operations adds accounts; drivers see only their own; duplicates are rejected", async () => {
    await withUserTx(as(ops), (tx) => tx.insert(driverPlatformAccounts).values({ driverId, platform: "inDrive", accountRef: "IND-001" }));
    await withUserTx(as(ops), (tx) => tx.insert(driverPlatformAccounts).values({ driverId: otherDriverId, platform: "inDrive", accountRef: "IND-002" }));
    await expectDbError(
      withUserTx(as(ops), (tx) => tx.insert(driverPlatformAccounts).values({ driverId: otherDriverId, platform: "INDRIVE", accountRef: "ind-001" })),
      /driver_platform_accounts_uq/,
    );
    const mine = await withUserTx(as(driverUser), (tx) => tx.select().from(driverPlatformAccounts));
    expect(mine.map((r) => r.accountRef)).toEqual(["IND-001"]);
    await expectDbError(
      withUserTx(as(driverUser), (tx) => tx.insert(driverPlatformAccounts).values({ driverId, platform: "Grab", accountRef: "G1" })),
      /row-level security/,
    );
  });
});

describe("driver alerts", () => {
  it("flags consecutive unpaid boundary days, high balances and expiring licences", async () => {
    const start = D("2026-10-05");
    const lazy = await newDriver();
    await withUserTx(as(ops), (tx) => startBoundaryPlan(tx, { driverId: lazy, programType: "boundary", dailyRate: pesos(700), effectiveFrom: start }, start));
    for (const day of ["2026-10-05", "2026-10-06", "2026-10-07"]) await withSystemTx("test:ops", (tx) => postBoundaryCharges(tx, D(day)));
    const expiring = await newDriver();
    await sql`UPDATE public.drivers SET license_expiry = '2026-10-30' WHERE id = ${expiring}`;
    const res = await withUserTx(as(finance), (tx) => driverAlerts(tx, D("2026-10-07")));
    const byId = new Map(res.rows.map((r) => [r.driver_id, r]));
    expect(byId.get(lazy)).toMatchObject({ unpaid_days: 3, balance: "210000" });
    expect(byId.get(expiring)?.license_expiry).toBe("2026-10-30");
    expect(byId.has(otherDriverId)).toBe(false);
    // The drivers list shows the same balance and the oldest unpaid due date.
    const list = await withUserTx(as(finance), (tx) => listDrivers(tx, { today: D("2026-10-08") }));
    const row = list.find((r) => r.id === lazy);
    expect(row).toMatchObject({ balance_centavos: "210000", oldest_unpaid_due: "2026-10-05" });
  });
});

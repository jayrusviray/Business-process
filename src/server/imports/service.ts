import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  boundaryPlans,
  driverAccounts,
  drivers,
  employees,
  importBatches,
  investors,
  legacyPayments,
  rtoContracts,
  vehicleAssignments,
  vehicles,
} from "@/db/schema";
import { jsonb } from "@/db/sql";
import { normalizeMobile } from "@/lib/crm";
import type { IsoDate } from "@/lib/dates";
import { namesMatch, plateKey } from "@/lib/imports/cells";
import { IMPORT_KIND_INFO, matchHeaders, type ImportKind } from "@/lib/imports/kinds";
import {
  investorKey,
  validateContractRows,
  validateDriverRows,
  validateEmployeeRows,
  validateInvestorRows,
  validateLegacyPaymentRows,
  validateOpeningBalanceRows,
  validatePlanRows,
  validateVehicleRows,
  type AccountKind,
  type RawRow,
  type RowContext,
  type Validated,
} from "@/lib/imports/rows";
import { formatPeso, sum, ZERO, type Centavos } from "@/lib/money";
import { monthlyAmortization, rtoSchedule } from "@/lib/rto";
import { importLeadRows } from "../crm/leads";
import { friendlyError, MoneyRuleError } from "../money/errors";
import { assignVehicle, ensureAccount, startBoundaryPlan } from "../money/fleet";
import { postAdjustment } from "../money/payments";
import { createRtoContract } from "../money/rto";
import { setVehicleInvestor } from "../office/investors";
import { getSetting } from "../office/settings";
import type { SheetTable } from "./read";

/**
 * Spreadsheet import (Phase 9). Every row is validated first (cells, then
 * look-ups against the database); the preview shows the result per row, and
 * nothing is written unless every row is valid. The commit runs in the
 * caller's transaction (withUserTx as owner_admin, so RLS applies) and records
 * an append-only import_batches row. Money rows are idempotent: opening
 * balances carry the key import:{batch}:{line}, and the same file (by SHA-256)
 * can only be imported once per kind.
 */

export type ImportAction = "create" | "skip" | "post" | "store" | "link";

export type ImportRowView = {
  line: number;
  label: string;
  detail: string;
  action: ImportAction | null;
  note: string;
  status: "ok" | "skip" | "warn" | "error";
};

export type ImportOutcome = {
  kind: ImportKind;
  fileName: string;
  committed: boolean;
  batchId: string | null;
  /** A problem with the whole file (missing columns, already imported…). */
  problem: string | null;
  ignoredColumns: string[];
  rows: ImportRowView[];
  counts: { rows: number; errors: number; ready: number; skipped: number; warnings: number };
  totals: { label: string; value: string }[];
};

export type RunImportInput = {
  kind: ImportKind;
  fileName: string;
  sha256: string;
  table: SheetTable;
  commit: boolean;
  /** Business date of the import (businessToday() in production). */
  today: IsoDate;
  /** As-of date (opening balances, legacy payments) or default plan start date. Defaults to today. */
  date?: IsoDate | null;
  /** Leads only: who new leads are assigned to (null = nobody). */
  assignLeadsTo?: string | null;
};

type Planned = {
  line: number;
  label: string;
  detail: string;
  action: ImportAction | null;
  note: string;
  warnings: string[];
  error?: string;
  /** Record id known before writing (pre-generated or existing), kept in the batch summary. */
  id?: string;
  run?: () => Promise<void>;
};

type Plan = { rows: Planned[]; totals: { label: string; value: string }[] };

type Ctx = {
  tx: Tx;
  today: IsoDate;
  batchId: string;
  fileName: string;
  cols: ReadonlyMap<string, string>;
  row: RowContext;
};

const ACCOUNT_LABEL: Record<AccountKind, string> = { boundary: "Boundary", amortization: "Amortization (RTO)", charges: "Costs & deposit" };

// ---------------------------------------------------------------------------
// Look-ups
// ---------------------------------------------------------------------------
type DriverRef = { id: string; name: string; status: string };
type VehicleRef = { id: string; plateNo: string; status: string; investorId: string | null };

/** Drivers by normalised mobile (09XXXXXXXXX). Two drivers sharing a number → ambiguous. */
async function driversByMobile(tx: Tx): Promise<Map<string, DriverRef[]>> {
  const rows = await tx
    .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName, phone: drivers.phone, status: drivers.status })
    .from(drivers);
  const map = new Map<string, DriverRef[]>();
  for (const d of rows) {
    const m = normalizeMobile(d.phone);
    const key = m.e164 ? m.mobile : d.phone.trim();
    map.set(key, [...(map.get(key) ?? []), { id: d.id, name: `${d.firstName} ${d.lastName}`, status: d.status }]);
  }
  return map;
}

async function vehiclesByPlate(tx: Tx): Promise<Map<string, VehicleRef[]>> {
  const rows = await tx
    .select({ id: vehicles.id, plateNo: vehicles.plateNo, status: vehicles.status, investorId: vehicles.investorId })
    .from(vehicles);
  const map = new Map<string, VehicleRef[]>();
  for (const v of rows) map.set(plateKey(v.plateNo), [...(map.get(plateKey(v.plateNo)) ?? []), v]);
  return map;
}

class RowProblem extends Error {}

function findDriver(map: Map<string, DriverRef[]>, mobile: string): DriverRef {
  const found = map.get(mobile) ?? [];
  if (found.length === 0) throw new RowProblem(`No driver with mobile ${mobile}. Import the drivers first.`);
  if (found.length > 1) throw new RowProblem(`${found.length} drivers share mobile ${mobile} (${found.map((d) => d.name).join(", ")}). Fix them first.`);
  return found[0];
}

function findVehicle(map: Map<string, VehicleRef[]>, plateNo: string, key: string): VehicleRef {
  const found = map.get(key) ?? [];
  if (found.length === 0) throw new RowProblem(`No vehicle with plate ${plateNo}. Import the vehicles first.`);
  if (found.length > 1) throw new RowProblem(`Several vehicles match plate ${plateNo}. Fix the duplicates first.`);
  return found[0];
}

function nameCheck(warnings: string[], fileName: string, driver: DriverRef): void {
  if (fileName && !namesMatch(fileName, driver.name)) warnings.push(`Name in the file ("${fileName}") doesn't match the driver found by mobile (${driver.name}).`);
}

function rawLabel(row: RawRow, cols: ReadonlyMap<string, string>, keys: string[]): string {
  for (const k of keys) {
    const h = cols.get(k);
    const v = h ? row.values[h]?.trim() : "";
    if (v) return v;
  }
  return "";
}

/** Planned rows for validation failures (cell errors), then `plan` for the valid ones. */
async function planRows<T>(
  ctx: Ctx,
  rows: readonly RawRow[],
  validated: Validated<T>[],
  labelKeys: string[],
  plan: (data: T, line: number, warnings: string[]) => Promise<Omit<Planned, "line" | "warnings">>,
): Promise<Planned[]> {
  const out: Planned[] = [];
  for (let i = 0; i < validated.length; i++) {
    const v = validated[i];
    const label = rawLabel(rows[i], ctx.cols, labelKeys);
    if (!v.data) {
      out.push({ line: v.line, label, detail: "", action: null, note: "", warnings: v.warnings, error: v.error });
      continue;
    }
    const warnings = [...v.warnings];
    try {
      out.push({ line: v.line, warnings, ...(await plan(v.data, v.line, warnings)) });
    } catch (e) {
      if (!(e instanceof RowProblem)) throw e;
      out.push({ line: v.line, label, detail: "", action: null, note: "", warnings, error: e.message });
    }
  }
  return out;
}

const peso = (c: Centavos) => formatPeso(c);
const MANILA_TIME = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
async function planVehicles(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const byPlate = await vehiclesByPlate(ctx.tx);
  const validated = validateVehicleRows(rows, ctx.cols, ctx.row);
  const planned = await planRows(ctx, rows, validated, ["plate_no"], async (v, _line, warnings) => {
    const detail = `${v.make} ${v.model}${v.year ? ` ${v.year}` : ""} · ${v.powertrain === "ev" ? "EV" : v.powertrain === "hybrid" ? "hybrid" : "ICE"}`;
    const existing = byPlate.get(v.plateKey);
    if (existing?.length) return { label: v.plateNo, detail, action: "skip", note: `Already exists as ${existing[0].plateNo} (not changed).`, id: existing[0].id };
    if (v.fundingSource === "investor") warnings.push("Funded by an investor: link it with the investors import.");
    const id = crypto.randomUUID();
    return {
      label: v.plateNo,
      detail,
      action: "create",
      note: "New vehicle",
      id,
      run: async () => {
        await ctx.tx.insert(vehicles).values({
          id,
          plateNo: v.plateNo,
          make: v.make,
          model: v.model,
          year: v.year,
          color: v.color,
          powertrain: v.powertrain,
          region: v.region,
          conductionSticker: v.conductionSticker,
          orcrExpiresOn: v.orcrExpiresOn,
          insuranceExpiresOn: v.insuranceExpiresOn,
          platforms: v.platforms,
          acquisitionCostCentavos: v.acquisitionCost,
          acquiredOn: v.acquiredOn,
          fundingSource: v.fundingSource,
          status: v.status,
          notes: v.notes,
        });
      },
    };
  });
  const created = planned.filter((p) => p.action === "create");
  const evs = validated.filter((v) => v.data?.powertrain === "ev").length;
  return { rows: planned, totals: [{ label: "New vehicles", value: String(created.length) }, { label: "EVs in file", value: String(evs) }] };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
async function planDrivers(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const byMobile = await driversByMobile(ctx.tx);
  const planned = await planRows(ctx, rows, validateDriverRows(rows, ctx.cols, ctx.row), ["name", "last_name", "mobile"], async (d) => {
    const label = `${d.firstName} ${d.lastName}`;
    const detail = `${d.phone} · ${d.status}`;
    const existing = byMobile.get(d.phone) ?? [];
    if (existing.length) return { label, detail, action: "skip", note: `Mobile already belongs to ${existing[0].name} (not changed).`, id: existing[0].id };
    const id = crypto.randomUUID();
    return {
      label,
      detail,
      action: "create",
      note: "New driver",
      id,
      run: async () => {
        await ctx.tx.insert(drivers).values({ id, ...d });
      },
    };
  });
  return { rows: planned, totals: [{ label: "New drivers", value: String(planned.filter((p) => p.action === "create").length) }] };
}

// ---------------------------------------------------------------------------
// Boundary plans (+ vehicle assignment)
// ---------------------------------------------------------------------------
async function planBoundaryPlans(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const { tx } = ctx;
  const byMobile = await driversByMobile(tx);
  const byPlate = await vehiclesByPlate(tx);
  const plans = await tx
    .select({ driverId: boundaryPlans.driverId, effectiveFrom: boundaryPlans.effectiveFrom, effectiveTo: boundaryPlans.effectiveTo, rate: boundaryPlans.dailyRateCentavos })
    .from(boundaryPlans);
  const open = await tx
    .select({ vehicleId: vehicleAssignments.vehicleId, driverId: vehicleAssignments.driverId, firstName: drivers.firstName, lastName: drivers.lastName, plateNo: vehicles.plateNo })
    .from(vehicleAssignments)
    .innerJoin(drivers, eq(drivers.id, vehicleAssignments.driverId))
    .innerJoin(vehicles, eq(vehicles.id, vehicleAssignments.vehicleId))
    .where(isNull(vehicleAssignments.endDate));
  let dailyTotal = ZERO;
  const planned = await planRows(ctx, rows, validatePlanRows(rows, ctx.cols, ctx.row), ["driver_name", "mobile"], async (p, _line, warnings) => {
    const driver = findDriver(byMobile, p.mobile);
    nameCheck(warnings, p.driverName, driver);
    const program = p.programType === "rto" ? "boundary-hulog / RTO" : "boundary";
    const detail = `${peso(p.dailyRate)}/day · ${program} · from ${p.startDate}${p.plateNo ? ` · ${p.plateNo}` : ""}`;
    const openPlan = plans.find((x) => x.driverId === driver.id && x.effectiveTo === null);
    if (openPlan) {
      return { label: driver.name, detail, action: "skip", note: `Already has a plan since ${openPlan.effectiveFrom} at ${peso(openPlan.rate)}/day (not changed).`, id: driver.id };
    }
    const ended = plans.find((x) => x.driverId === driver.id && x.effectiveTo !== null && x.effectiveTo >= p.startDate);
    if (ended) throw new RowProblem(`Overlaps an ended plan that runs until ${ended.effectiveTo}. Start the new plan after that day.`);
    let vehicleId: string | null = null;
    const driverCar = open.find((a) => a.driverId === driver.id);
    if (p.plateNo && p.plateKey) {
      const v = findVehicle(byPlate, p.plateNo, p.plateKey);
      if (v.status === "retired" || v.status === "transferred") throw new RowProblem(`Vehicle ${v.plateNo} is ${v.status}.`);
      const holder = open.find((a) => a.vehicleId === v.id);
      if (holder && holder.driverId !== driver.id) throw new RowProblem(`Vehicle ${v.plateNo} is assigned to ${holder.firstName} ${holder.lastName}.`);
      if (driverCar && driverCar.vehicleId !== v.id) throw new RowProblem(`${driver.name} already drives ${driverCar.plateNo}. Return it first.`);
      if (!holder) vehicleId = v.id;
    } else if (!driverCar) {
      warnings.push("No vehicle given: charges are posted without a vehicle until one is assigned.");
    }
    if (driver.status !== "active") warnings.push(`Driver is ${driver.status}: no boundary is charged until they are active.`);
    dailyTotal += p.dailyRate;
    return {
      label: driver.name,
      detail,
      action: "create",
      note: vehicleId ? "New plan + vehicle assignment" : "New plan",
      id: driver.id,
      run: async () => {
        await startBoundaryPlan(tx, { driverId: driver.id, programType: p.programType, dailyRate: p.dailyRate, effectiveFrom: p.startDate, notes: p.notes }, ctx.today);
        if (vehicleId) await assignVehicle(tx, { driverId: driver.id, vehicleId, startDate: p.startDate, reason: "Imported with the boundary plan" });
      },
    };
  });
  const starting = planned.filter((p) => p.action === "create");
  return {
    rows: planned,
    totals: [
      { label: "New plans", value: String(starting.length) },
      { label: "Daily boundary of new plans", value: peso(dailyTotal) },
    ],
  };
}

// ---------------------------------------------------------------------------
// RTO contracts
// ---------------------------------------------------------------------------
async function planContracts(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const { tx } = ctx;
  const byMobile = await driversByMobile(tx);
  const byPlate = await vehiclesByPlate(tx);
  const active = await tx
    .select({ id: rtoContracts.id, contractNo: rtoContracts.contractNo, driverId: rtoContracts.driverId, vehicleId: rtoContracts.vehicleId })
    .from(rtoContracts)
    .where(eq(rtoContracts.status, "active"));
  let postedTotal = ZERO;
  let creditTotal = ZERO;
  const planned = await planRows(ctx, rows, validateContractRows(rows, ctx.cols, ctx.row), ["driver_name", "mobile"], async (c, line, warnings) => {
    const driver = findDriver(byMobile, c.mobile);
    nameCheck(warnings, c.driverName, driver);
    const v = findVehicle(byPlate, c.plateNo, c.plateKey);
    const monthly = monthlyAmortization(c);
    const dueNow = rtoSchedule(c).filter((i) => i.dueDate <= ctx.today);
    const posted = sum(dueNow.map((i) => i.amount));
    const balance = posted - c.paidToDate;
    const detail = `${v.plateNo} · price ${peso(c.contractPrice)} · ${peso(monthly)}/month × ${c.termMonths} from ${c.firstDueDate} · ${dueNow.length} due by today (${peso(posted)}) − paid ${peso(c.paidToDate)} = ${balance < ZERO ? `advance ${peso(-balance)}` : peso(balance)}`;
    const mine = active.find((a) => a.driverId === driver.id);
    if (mine?.vehicleId === v.id) return { label: driver.name, detail, action: "skip", note: `Contract ${mine.contractNo} already exists (not changed).`, id: mine.id };
    if (mine) throw new RowProblem(`${driver.name} already has active contract ${mine.contractNo} for another vehicle.`);
    const other = active.find((a) => a.vehicleId === v.id);
    if (other) throw new RowProblem(`Vehicle ${v.plateNo} already has active contract ${other.contractNo}.`);
    if (v.status === "retired" || v.status === "transferred") throw new RowProblem(`Vehicle ${v.plateNo} is ${v.status}.`);
    if (balance < ZERO) warnings.push(`Paid to date is more than what is due so far: the driver starts with a ${peso(-balance)} advance.`);
    postedTotal += posted;
    creditTotal += c.paidToDate;
    const notes = [`Imported from ${ctx.fileName} (line ${line})`, c.oldContractNo ? `old contract no. ${c.oldContractNo}` : "", c.notes].filter(Boolean).join("; ");
    return {
      label: driver.name,
      detail,
      action: "create",
      note: "New contract",
      id: driver.id,
      run: async () => {
        await createRtoContract(
          tx,
          {
            driverId: driver.id,
            vehicleId: v.id,
            contractPrice: c.contractPrice,
            downPayment: c.downPayment,
            termMonths: c.termMonths,
            startDate: c.startDate,
            firstDueDate: c.firstDueDate,
            paidBeforeGoLive: c.paidToDate,
            openingCreditKey: `import:${ctx.batchId}:${line}`,
            notes,
          },
          ctx.today,
        );
      },
    };
  });
  return {
    rows: planned,
    totals: [
      { label: "New contracts", value: String(planned.filter((p) => p.action === "create").length) },
      { label: "Installments posted now", value: peso(postedTotal) },
      { label: "Opening credits (paid to date)", value: peso(creditTotal) },
      { label: "Amortization balance after import", value: peso(postedTotal - creditTotal) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Opening balances
// ---------------------------------------------------------------------------
async function planOpeningBalances(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const { tx } = ctx;
  const asOf = ctx.row.asOf;
  const byMobile = await driversByMobile(tx);
  const accounts = await tx
    .select({ id: driverAccounts.id, driverId: driverAccounts.driverId, kind: driverAccounts.kind, contractId: driverAccounts.contractId, closedOn: driverAccounts.closedOn })
    .from(driverAccounts);
  const contracts = await tx
    .select({ id: rtoContracts.id, contractNo: rtoContracts.contractNo, driverId: rtoContracts.driverId, accountId: rtoContracts.accountId, status: rtoContracts.status })
    .from(rtoContracts);
  const existing = await tx.execute<{ account_id: string; total: string; first_date: string }>(sql`
    SELECT e.account_id, SUM(e.amount_centavos)::text AS total, MIN(e.business_date)::text AS first_date
    FROM public.ledger_entries e
    WHERE e.entry_type = 'opening_balance'
      AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id)
    GROUP BY e.account_id`);
  const hasOpening = new Map(existing.map((r) => [r.account_id, r]));
  const totals: Record<AccountKind, { owed: Centavos; credit: Centavos }> = {
    boundary: { owed: ZERO, credit: ZERO },
    charges: { owed: ZERO, credit: ZERO },
    amortization: { owed: ZERO, credit: ZERO },
  };

  const planned = await planRows(ctx, rows, validateOpeningBalanceRows(rows, ctx.cols, ctx.row), ["driver_name", "mobile"], async (b, line, warnings) => {
    const driver = findDriver(byMobile, b.mobile);
    nameCheck(warnings, b.driverName, driver);
    let accountId: string | null = null;
    if (b.account === "amortization") {
      const mine = contracts.filter((c) => c.driverId === driver.id);
      const contract = b.contractNo ? mine.find((c) => c.contractNo.toUpperCase() === b.contractNo) : mine.find((c) => c.status === "active");
      if (!contract) {
        throw new RowProblem(
          b.contractNo ? `${driver.name} has no contract ${b.contractNo}.` : `${driver.name} has no active RTO contract. Import the RTO contracts first.`,
        );
      }
      accountId = contract.accountId;
    } else {
      accountId = accounts.find((a) => a.driverId === driver.id && a.kind === b.account)?.id ?? null;
    }
    const prior = accountId ? hasOpening.get(accountId) : undefined;
    if (prior) {
      throw new RowProblem(
        `${driver.name}'s ${ACCOUNT_LABEL[b.account]} account already has an opening balance of ${peso(BigInt(prior.total))} (dated ${prior.first_date}). Reverse it on the driver page first if it is wrong.`,
      );
    }
    const due = b.dueDate ?? asOf;
    const detail = `${ACCOUNT_LABEL[b.account]} · ${b.amount > ZERO ? `owes ${peso(b.amount)} · due ${due}` : `credit ${peso(-b.amount)}`}`;
    if (b.amount > ZERO) totals[b.account].owed += b.amount;
    else totals[b.account].credit += -b.amount;
    const reason = `Opening balance from spreadsheet import${b.notes ? `: ${b.notes}` : ""}`;
    return {
      label: driver.name,
      detail,
      action: "post",
      note: "Opening balance",
      id: driver.id,
      run: async () => {
        const acct = accountId ?? (await ensureAccount(tx, driver.id, b.account as "boundary" | "charges", asOf));
        await postAdjustment(tx, {
          accountId: acct,
          amount: b.amount,
          reason,
          businessDate: asOf,
          dueDate: b.amount > ZERO ? due : undefined,
          type: "opening_balance",
          idempotencyKey: `import:${ctx.batchId}:${line}`,
          memo: `Opening balance (import line ${line})`,
        });
      },
    };
  });
  const out: { label: string; value: string }[] = [];
  for (const k of ["boundary", "charges", "amortization"] as const) {
    if (totals[k].owed === ZERO && totals[k].credit === ZERO) continue;
    out.push({ label: `${ACCOUNT_LABEL[k]}: owed`, value: peso(totals[k].owed) });
    if (totals[k].credit > ZERO) out.push({ label: `${ACCOUNT_LABEL[k]}: credits`, value: peso(totals[k].credit) });
  }
  const net = sum(Object.values(totals).map((t) => t.owed - t.credit));
  out.push({ label: "Net opening balance", value: peso(net) });
  return { rows: planned, totals: out };
}

// ---------------------------------------------------------------------------
// Payments before go-live (reference only)
// ---------------------------------------------------------------------------
async function planLegacyPayments(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const { tx } = ctx;
  const byMobile = await driversByMobile(tx);
  const prior = await tx.select({ driverId: legacyPayments.driverId, paidOn: legacyPayments.paidOn, amount: legacyPayments.amountCentavos }).from(legacyPayments);
  const seen = new Set(prior.map((p) => `${p.driverId}|${p.paidOn}|${p.amount}`));
  let total = ZERO;
  const planned = await planRows(ctx, rows, validateLegacyPaymentRows(rows, ctx.cols, ctx.row), ["driver_name", "mobile"], async (p, line, warnings) => {
    const driver = findDriver(byMobile, p.mobile);
    nameCheck(warnings, p.driverName, driver);
    if (seen.has(`${driver.id}|${p.paidOn}|${p.amount}`)) warnings.push("A payment with the same date and amount is already stored from an earlier import.");
    total += p.amount;
    return {
      label: driver.name,
      detail: `${p.paidOn} · ${peso(p.amount)} · ${p.method.replace("_", " ")}${p.referenceNo ? ` ${p.referenceNo}` : ""}${p.account ? ` · ${ACCOUNT_LABEL[p.account]}` : ""}`,
      action: "store",
      note: "Reference only",
      id: driver.id,
      run: async () => {
        await tx.insert(legacyPayments).values({
          driverId: driver.id,
          paidOn: p.paidOn,
          amountCentavos: p.amount,
          method: p.method,
          referenceNo: p.referenceNo,
          account: p.account,
          notes: p.notes,
          batchId: ctx.batchId,
          line,
        });
      },
    };
  });
  return { rows: planned, totals: [{ label: "Payments before go-live (reference only)", value: peso(total) }] };
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
async function planEmployees(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const existing = await ctx.tx.select({ id: employees.id, employeeNo: employees.employeeNo }).from(employees);
  const byNo = new Map(existing.map((e) => [e.employeeNo.trim().toUpperCase(), e.id]));
  const planned = await planRows(ctx, rows, validateEmployeeRows(rows, ctx.cols, ctx.row), ["name", "last_name", "employee_no"], async (e) => {
    const label = `${e.firstName} ${e.lastName}`;
    const detail = `${e.employeeNo} · ${e.position || "—"} · ${peso(e.rate)} ${e.basis === "monthly" ? "/month" : "/day"}`;
    const found = byNo.get(e.employeeNo.toUpperCase());
    if (found) return { label, detail, action: "skip", note: "Employee number already exists (not changed).", id: found };
    const id = crypto.randomUUID();
    return {
      label,
      detail,
      action: "create",
      note: "New employee",
      id,
      run: async () => {
        await ctx.tx.insert(employees).values({
          id,
          employeeNo: e.employeeNo,
          firstName: e.firstName,
          lastName: e.lastName,
          position: e.position,
          hireDate: e.hireDate,
          separationDate: e.separationDate,
          basis: e.basis,
          rateCentavos: e.rate,
          allowanceCentavos: e.allowance,
          allowanceTaxable: e.allowanceTaxable,
          tin: e.tin,
          sssNo: e.sssNo,
          philhealthNo: e.philhealthNo,
          pagibigNo: e.pagibigNo,
          bankAccount: e.bankAccount,
          status: e.status,
        });
      },
    };
  });
  return { rows: planned, totals: [{ label: "New employees", value: String(planned.filter((p) => p.action === "create").length) }] };
}

// ---------------------------------------------------------------------------
// Investors (+ their vehicles)
// ---------------------------------------------------------------------------
async function planInvestors(ctx: Ctx, rows: readonly RawRow[]): Promise<Plan> {
  const { tx } = ctx;
  const existing = await tx.select({ id: investors.id, name: investors.name }).from(investors);
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const i of existing) byName.set(investorKey(i.name), [...(byName.get(investorKey(i.name)) ?? []), i]);
  const names = new Map(existing.map((i) => [i.id, i.name]));
  const byPlate = await vehiclesByPlate(tx);
  let linked = 0;
  const planned = await planRows(ctx, rows, validateInvestorRows(rows, ctx.cols), ["name"], async (inv) => {
    const found = byName.get(investorKey(inv.name)) ?? [];
    if (found.length > 1) throw new RowProblem(`${found.length} investors are named "${inv.name}". Fix them first.`);
    const investorId = found[0]?.id ?? crypto.randomUUID();
    const toLink: string[] = [];
    for (const p of inv.plates) {
      const v = findVehicle(byPlate, p.plateNo, p.plateKey);
      if (v.investorId && v.investorId !== investorId) throw new RowProblem(`Vehicle ${v.plateNo} already belongs to investor ${names.get(v.investorId) ?? "another investor"}.`);
      if (v.investorId !== investorId) toLink.push(v.id);
    }
    linked += toLink.length;
    const detail = inv.plates.length ? count(inv.plates.length, "vehicle") + `: ${inv.plates.map((p) => p.plateNo).join(", ")}` : "No vehicles";
    const link = async () => {
      for (const vehicleId of toLink) await setVehicleInvestor(tx, vehicleId, investorId);
    };
    if (found[0]) {
      return toLink.length
        ? { label: inv.name, detail, action: "link", note: `Existing investor: links ${count(toLink.length, "vehicle")}`, id: investorId, run: link }
        : { label: inv.name, detail, action: "skip", note: "Already exists (not changed).", id: investorId };
    }
    return {
      label: inv.name,
      detail,
      action: "create",
      note: toLink.length ? `New investor + ${count(toLink.length, "vehicle")}` : "New investor",
      id: investorId,
      run: async () => {
        await tx.insert(investors).values({ id: investorId, name: inv.name, phone: inv.phone, email: inv.email, notes: inv.notes });
        await link();
      },
    };
  });
  return {
    rows: planned,
    totals: [
      { label: "New investors", value: String(planned.filter((p) => p.action === "create").length) },
      { label: "Vehicles linked", value: String(linked) },
    ],
  };
}

const PLANNERS: Record<Exclude<ImportKind, "leads">, (ctx: Ctx, rows: readonly RawRow[]) => Promise<Plan>> = {
  vehicles: planVehicles,
  drivers: planDrivers,
  boundary_plans: planBoundaryPlans,
  rto_contracts: planContracts,
  opening_balances: planOpeningBalances,
  legacy_payments: planLegacyPayments,
  employees: planEmployees,
  investors: planInvestors,
};

function view(p: Planned): ImportRowView {
  if (p.error) return { line: p.line, label: p.label, detail: p.detail, action: null, note: [p.error, ...p.warnings].join(" "), status: "error" };
  const note = [p.note, ...p.warnings].filter(Boolean).join(" ");
  return { line: p.line, label: p.label, detail: p.detail, action: p.action, note, status: p.action === "skip" ? "skip" : p.warnings.length ? "warn" : "ok" };
}

function counts(rows: ImportRowView[]): ImportOutcome["counts"] {
  return {
    rows: rows.length,
    errors: rows.filter((r) => r.status === "error").length,
    ready: rows.filter((r) => r.status !== "error" && r.action !== "skip").length,
    skipped: rows.filter((r) => r.action === "skip").length,
    warnings: rows.filter((r) => r.status === "warn").length,
  };
}

async function insertBatch(tx: Tx, values: typeof importBatches.$inferInsert): Promise<void> {
  try {
    await tx.insert(importBatches).values(values);
  } catch (e) {
    const err = e as Error & { cause?: Error };
    if (/import_batches_kind_file_uq/.test(`${err.message} ${err.cause?.message ?? ""}`)) {
      throw new MoneyRuleError("This exact file was already imported. Nothing was changed.");
    }
    throw e;
  }
}

/** Leads go through the CRM import (duplicates by mobile join the open lead's timeline). */
async function runLeadImport(tx: Tx, input: RunImportInput, outcome: ImportOutcome, batchId: string): Promise<ImportOutcome> {
  const rows = input.table.rows;
  const values = rows.map((r) => r.values);
  const res = await importLeadRows(tx, { rows: values, commit: false, assignTo: input.assignLeadsTo ?? null });
  outcome.rows = res.rows.map((r, i) => ({
    line: rows[i]?.line ?? r.line,
    label: r.name,
    detail: [r.mobile || r.email || r.fbName, r.source.replace("_", " "), r.interest.replace("_", " ")].filter(Boolean).join(" · "),
    action: r.error ? null : r.duplicateOf ? "link" : "create",
    note: r.error ?? (r.duplicateOf ? `Added to the open lead of ${r.duplicateOf}` : "New lead"),
    status: r.error ? "error" : r.duplicateOf ? "warn" : "ok",
  }));
  outcome.counts = counts(outcome.rows);
  outcome.totals = [
    { label: "New leads", value: String(res.rows.filter((r) => !r.error && !r.duplicateOf).length) },
    { label: "Added to existing leads", value: String(res.rows.filter((r) => !r.error && r.duplicateOf).length) },
  ];
  if (!input.commit || outcome.counts.errors > 0) return outcome;
  await insertBatch(tx, {
    id: batchId,
    kind: "leads",
    fileName: input.fileName.slice(0, 200),
    fileSha256: input.sha256,
    rowCount: rows.length,
    asOf: null,
    summary: jsonb({ counts: outcome.counts, totals: outcome.totals, ignoredColumns: outcome.ignoredColumns }),
  });
  const done = await importLeadRows(tx, { rows: values, commit: true, assignTo: input.assignLeadsTo ?? null, sourceLabel: `import ${input.fileName.slice(0, 80)}` });
  if (!done.committed) throw new MoneyRuleError("The leads changed while importing. Nothing was imported; try again.");
  return { ...outcome, committed: true, batchId };
}

/** Validates a spreadsheet and, when `commit` is set and every row is valid, imports it. */
export async function runImport(tx: Tx, input: RunImportInput): Promise<ImportOutcome> {
  const info = IMPORT_KIND_INFO[input.kind];
  const match = matchHeaders(input.kind, input.table.headers);
  const outcome: ImportOutcome = {
    kind: input.kind,
    fileName: input.fileName,
    committed: false,
    batchId: null,
    problem: null,
    ignoredColumns: match.ignored,
    rows: [],
    counts: { rows: input.table.rows.length, errors: 0, ready: 0, skipped: 0, warnings: 0 },
    totals: [],
  };
  const fail = (problem: string): ImportOutcome => ({ ...outcome, problem });
  if (match.missing.length) {
    return fail(`Missing column${match.missing.length > 1 ? "s" : ""}: ${match.missing.join(", ")}. Download the template to see the expected columns.`);
  }
  if (input.table.rows.length === 0) return fail("The file has no rows under the header row.");
  const date = input.date ?? input.today;
  if (info.dateParam === "asOf" && date > input.today) return fail("The as-of date can't be in the future.");
  if (info.dateParam === "startDate" && date < input.today) return fail("Plans can't start in the past. Choose today or a later date.");

  const [prev] = await tx
    .select({ createdAt: importBatches.createdAt })
    .from(importBatches)
    .where(and(eq(importBatches.kind, input.kind), eq(importBatches.fileSha256, input.sha256)));
  if (prev) return fail(`This exact file was already imported (${MANILA_TIME.format(prev.createdAt)}). Nothing was changed.`);

  const batchId = crypto.randomUUID();
  if (input.kind === "leads") return runLeadImport(tx, input, outcome, batchId);

  const ctx: Ctx = {
    tx,
    today: input.today,
    batchId,
    fileName: input.fileName.slice(0, 200),
    cols: match.columns,
    row: {
      today: input.today,
      asOf: date,
      startDate: date,
      date1904: input.table.date1904,
      defaultTermMonths: await getSetting(tx, "rto.default_term_months"),
    },
  };
  const plan = await PLANNERS[input.kind](ctx, input.table.rows);
  outcome.rows = plan.rows.map(view);
  outcome.counts = counts(outcome.rows);
  outcome.totals = plan.totals;
  if (!input.commit || outcome.counts.errors > 0) return outcome;

  await insertBatch(tx, {
    id: batchId,
    kind: input.kind,
    fileName: ctx.fileName,
    fileSha256: input.sha256,
    rowCount: input.table.rows.length,
    asOf: info.dateParam ? date : null,
    summary: jsonb({
      counts: outcome.counts,
      totals: outcome.totals,
      ignoredColumns: outcome.ignoredColumns,
      lines: plan.rows.map((p) => ({ line: p.line, action: p.action, ...(p.id ? { id: p.id } : {}) })),
    }),
  });
  for (const p of plan.rows) {
    if (!p.run) continue;
    try {
      await p.run();
    } catch (e) {
      throw new MoneyRuleError(`Line ${p.line}: ${friendlyError(e)} Nothing was imported.`);
    }
  }
  return { ...outcome, committed: true, batchId };
}

/** Recent import batches, newest first (owner_admin only by RLS). */
export async function listImportBatches(tx: Tx, limit = 50) {
  return tx.execute<{
    id: string;
    kind: string;
    file_name: string;
    row_count: number;
    as_of: string | null;
    summary: { counts?: ImportOutcome["counts"]; totals?: ImportOutcome["totals"] };
    created_at: string;
    created_by_name: string | null;
  }>(sql`
    SELECT b.id, b.kind, b.file_name, b.row_count, b.as_of::text, b.summary, b.created_at::text,
      COALESCE(NULLIF(p.full_name, ''), p.email) AS created_by_name
    FROM public.import_batches b
    LEFT JOIN public.profiles p ON p.id = b.created_by
    ORDER BY b.created_at DESC
    LIMIT ${limit}`);
}

/** Payments recorded in the old sheets for one driver (reference only). */
export async function listLegacyPayments(tx: Tx, driverId: string) {
  return tx
    .select()
    .from(legacyPayments)
    .where(eq(legacyPayments.driverId, driverId))
    .orderBy(desc(legacyPayments.paidOn), desc(legacyPayments.line));
}

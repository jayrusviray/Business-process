import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings, driverAccounts, ledgerEntries, rtoContracts, vehicles } from "@/db/schema";
import type { IsoDate } from "@/lib/dates";
import { allocateAccount, countMissed, type EntryType } from "@/lib/ledger/allocation";
import { formatPeso, sum, ZERO, type Centavos } from "@/lib/money";
import { cashoutQuote, rtoProgress, rtoSchedule, validateTerms, type RtoTerms } from "@/lib/rto";
import { MoneyRuleError } from "./errors";
import { lockDriver } from "./fleet";

type Contract = typeof rtoContracts.$inferSelect;

export function termsOf(c: Contract): RtoTerms {
  return {
    contractPrice: c.contractPriceCentavos,
    downPayment: c.downPaymentCentavos,
    termMonths: c.termMonths,
    startDate: c.startDate as IsoDate,
    firstDueDate: c.firstDueDate as IsoDate,
  };
}

/**
 * Posts every installment (and the down payment) of one contract that is due
 * on or before `upTo`. Idempotent (`amort:{contract}:{seq}`). Used at contract
 * set-up (catch-up for contracts signed before go-live) and by the daily job.
 */
export async function postAmortizationThrough(tx: Tx, contract: Contract, upTo: IsoDate): Promise<number> {
  if (contract.status !== "active") return 0;
  const due = rtoSchedule(termsOf(contract)).filter((i) => i.dueDate <= upTo);
  if (due.length === 0) return 0;
  const rows = await tx
    .insert(ledgerEntries)
    .values(
      due.map((i) => ({
        accountId: contract.accountId,
        driverId: contract.driverId,
        entryType: "amortization_charge" as const,
        amountCentavos: i.amount,
        businessDate: i.dueDate,
        dueDate: i.dueDate,
        vehicleId: contract.vehicleId,
        idempotencyKey: `amort:${contract.id}:${i.seq}`,
        memo: i.kind === "down_payment" ? `Down payment – ${contract.contractNo}` : `Amortization ${i.seq}/${contract.termMonths} – ${contract.contractNo}`,
      })),
    )
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });
  return rows.length;
}

/** Daily job step: installments falling due on `date` for all active contracts. */
export async function postAmortizationCharges(tx: Tx, date: IsoDate): Promise<number> {
  const active = await tx.select().from(rtoContracts).where(eq(rtoContracts.status, "active"));
  let n = 0;
  for (const c of active) n += await postAmortizationThrough(tx, c, date);
  return n;
}

export type NewContractInput = {
  driverId: string;
  vehicleId: string;
  contractPrice: Centavos;
  downPayment: Centavos;
  termMonths: number;
  startDate: IsoDate;
  firstDueDate: IsoDate;
  /** Amount the driver already paid toward the vehicle before go-live (posted as an opening credit). */
  paidBeforeGoLive?: Centavos;
  notes?: string;
};

export async function createRtoContract(tx: Tx, input: NewContractInput, today: IsoDate): Promise<string> {
  const terms: RtoTerms = { ...input };
  const invalid = validateTerms(terms);
  if (invalid) throw new MoneyRuleError(invalid);
  if ((input.paidBeforeGoLive ?? ZERO) < ZERO) throw new MoneyRuleError("Amount paid before go-live cannot be negative.");
  if ((input.paidBeforeGoLive ?? ZERO) > input.contractPrice) throw new MoneyRuleError("Amount paid before go-live exceeds the contract price.");
  await lockDriver(tx, input.driverId);

  const id = crypto.randomUUID();
  const [account] = await tx
    .insert(driverAccounts)
    .values({ driverId: input.driverId, kind: "amortization", contractId: id, openedOn: input.startDate })
    .returning({ id: driverAccounts.id });
  const [contract] = await tx
    .insert(rtoContracts)
    .values({
      id,
      driverId: input.driverId,
      vehicleId: input.vehicleId,
      accountId: account.id,
      contractPriceCentavos: input.contractPrice,
      downPaymentCentavos: input.downPayment,
      termMonths: input.termMonths,
      startDate: input.startDate,
      firstDueDate: input.firstDueDate,
      notes: input.notes ?? "",
    })
    .returning();

  if (input.paidBeforeGoLive && input.paidBeforeGoLive > ZERO) {
    await tx.insert(ledgerEntries).values({
      accountId: account.id,
      driverId: input.driverId,
      entryType: "opening_balance",
      amountCentavos: -input.paidBeforeGoLive,
      businessDate: today,
      reason: "Paid toward the vehicle before the system went live",
      memo: `Opening credit – ${contract.contractNo}`,
    });
  }
  await postAmortizationThrough(tx, contract, today);
  return id;
}

export type RtoStatus = Awaited<ReturnType<typeof getRtoStatus>>;

/** Contract with its ledger-derived progress, missed installments and cashout quote. */
export async function getRtoStatus(tx: Tx, contractId: string, asOf: IsoDate) {
  const [contract] = await tx.select().from(rtoContracts).where(eq(rtoContracts.id, contractId));
  if (!contract) return null;
  const entries = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, contract.accountId));
  const allocation = allocateAccount(
    entries.map((e) => ({
      id: e.id,
      seq: e.seq,
      entryType: e.entryType as EntryType,
      amount: e.amountCentavos,
      businessDate: e.businessDate as IsoDate,
      dueDate: e.dueDate as IsoDate | null,
      reversesEntryId: e.reversesEntryId,
    })),
  );
  const postedDebits = sum(allocation.charges.map((c) => c.amount));
  const netCredits = postedDebits - allocation.balance;
  const terms = termsOf(contract);
  return {
    contract,
    terms,
    allocation,
    progress: rtoProgress(terms, netCredits, asOf),
    quote: cashoutQuote(terms, postedDebits, netCredits),
    missed: countMissed(allocation, asOf),
    overpaid: netCredits > contract.contractPriceCentavos ? netCredits - contract.contractPriceCentavos : ZERO,
  };
}

/**
 * Closes a fully paid contract: posts any not-yet-posted principal as a single
 * payoff charge (so the account nets to zero), closes the amortization account,
 * and marks the vehicle as transferred to the driver. Owner: cashout = remaining
 * principal, no discounts or fees.
 */
export async function closePaidContract(tx: Tx, contractId: string, today: IsoDate): Promise<"completed" | "cashed_out"> {
  const status = await getRtoStatus(tx, contractId, today);
  if (!status) throw new MoneyRuleError("Contract not found.");
  const { contract, quote } = status;
  if (contract.status !== "active") throw new MoneyRuleError("This contract is already closed.");
  await lockDriver(tx, contract.driverId);
  if (quote.remainingPrincipal > ZERO) {
    throw new MoneyRuleError(`The driver still owes ${formatPeso(quote.remainingPrincipal)} on this contract. Record the payment on the Amortization account first.`);
  }

  const [setting] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "rto.cashout_requires_clear_balances"));
  if (setting?.value !== false) {
    const others = await tx.execute<{ kind: string; balance_centavos: string }>(sql`
      SELECT kind, balance_centavos::text FROM public.v_account_balances
      WHERE driver_id = ${contract.driverId} AND kind IN ('boundary', 'charges') AND balance_centavos > 0`);
    if (others.length) {
      throw new MoneyRuleError(
        `Clear the driver's other balances first: ${others.map((o) => `${o.kind} ${formatPeso(BigInt(o.balance_centavos))}`).join(", ")}.`,
      );
    }
  }

  if (quote.unpostedPrincipal > ZERO) {
    await tx.insert(ledgerEntries).values({
      accountId: contract.accountId,
      driverId: contract.driverId,
      entryType: "amortization_charge",
      amountCentavos: quote.unpostedPrincipal,
      businessDate: today,
      dueDate: today,
      vehicleId: contract.vehicleId,
      idempotencyKey: `amort:${contract.id}:payoff`,
      memo: `Early buyout – remaining principal – ${contract.contractNo}`,
    });
  }
  const finalStatus = quote.unpostedPrincipal > ZERO ? "cashed_out" : "completed";
  await tx
    .update(rtoContracts)
    .set({ status: finalStatus, closedOn: today, closeReason: finalStatus === "cashed_out" ? "Early buyout (cashout)" : "All installments paid" })
    .where(eq(rtoContracts.id, contract.id));
  const closed = await tx.update(driverAccounts).set({ closedOn: today }).where(eq(driverAccounts.id, contract.accountId)).returning({ id: driverAccounts.id });
  const moved = await tx.update(vehicles).set({ status: "transferred" }).where(eq(vehicles.id, contract.vehicleId)).returning({ id: vehicles.id });
  // RLS silently filters UPDATEs; make a missing permission fail loudly instead.
  if (closed.length !== 1 || moved.length !== 1) throw new MoneyRuleError("You are not allowed to close this contract.");
  return finalStatus;
}

/** Ends a contract without transfer (e.g. repossession). Future installments are not posted; arrears stay owed. */
export async function terminateContract(tx: Tx, contractId: string, reason: string, today: IsoDate): Promise<void> {
  if (!reason.trim()) throw new MoneyRuleError("A reason is required.");
  const res = await tx
    .update(rtoContracts)
    .set({ status: "terminated", closedOn: today, closeReason: reason.trim() })
    .where(and(eq(rtoContracts.id, contractId), eq(rtoContracts.status, "active")))
    .returning({ id: rtoContracts.id });
  if (res.length === 0) throw new MoneyRuleError("Contract not found or already closed.");
}

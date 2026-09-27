import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { loanPayments, loanScheduleLines, vehicleLoans } from "@/db/schema";
import { addDays, type IsoDate } from "@/lib/dates";
import { applyLoanPayments, loanSchedule, type LoanLine } from "@/lib/loans";
import { sum, ZERO, type Centavos } from "@/lib/money";
import { MoneyRuleError } from "./errors";

export async function createVehicleLoan(
  tx: Tx,
  input: { vehicleId: string; lender: string; principal: Centavos; annualRateBps: number; termMonths: number; firstDueDate: IsoDate; notes?: string },
): Promise<string> {
  if (input.principal <= ZERO) throw new MoneyRuleError("Loan amount must be more than ₱0.00.");
  if (input.annualRateBps < 0 || input.annualRateBps > 10000) throw new MoneyRuleError("Rate must be 0–100%.");
  if (input.termMonths < 1 || input.termMonths > 120) throw new MoneyRuleError("Term must be 1–120 months.");
  const [loan] = await tx
    .insert(vehicleLoans)
    .values({ ...input, principalCentavos: input.principal, notes: input.notes ?? "" })
    .returning({ id: vehicleLoans.id });
  const lines = loanSchedule({ principal: input.principal, annualRateBps: input.annualRateBps, termMonths: input.termMonths, firstDueDate: input.firstDueDate });
  await tx.insert(loanScheduleLines).values(
    lines.map((l) => ({
      loanId: loan.id,
      seq: l.seq,
      dueDate: l.dueDate,
      openingBalanceCentavos: l.opening,
      principalCentavos: l.principal,
      interestCentavos: l.interest,
      paymentCentavos: l.payment,
      closingBalanceCentavos: l.closing,
    })),
  );
  return loan.id;
}

export async function recordLoanPayment(
  tx: Tx,
  input: { loanId: string; paidOn: IsoDate; amount: Centavos; reference?: string; notes?: string },
): Promise<string> {
  if (input.amount <= ZERO) throw new MoneyRuleError("Amount must be more than ₱0.00.");
  const [row] = await tx
    .insert(loanPayments)
    .values({ loanId: input.loanId, paidOn: input.paidOn, amountCentavos: input.amount, reference: input.reference ?? "", notes: input.notes ?? "" })
    .returning({ id: loanPayments.id });
  const status = await getLoanStatus(tx, input.loanId, input.paidOn);
  if (status && status.balance === ZERO) {
    await tx.update(vehicleLoans).set({ status: "paid_off" }).where(eq(vehicleLoans.id, input.loanId));
  }
  return row.id;
}

export async function reverseLoanPayment(tx: Tx, input: { paymentId: string; reason: string; today: IsoDate }): Promise<void> {
  if (!input.reason.trim()) throw new MoneyRuleError("A reason is required.");
  const [p] = await tx.select().from(loanPayments).where(eq(loanPayments.id, input.paymentId));
  if (!p || p.reversesPaymentId) throw new MoneyRuleError("Payment not found.");
  await tx.insert(loanPayments).values({
    loanId: p.loanId,
    paidOn: input.today,
    amountCentavos: -p.amountCentavos,
    reversesPaymentId: p.id,
    notes: input.reason.trim(),
  });
}

export async function getLoanStatus(tx: Tx, loanId: string, asOf: IsoDate) {
  const [loan] = await tx.select().from(vehicleLoans).where(eq(vehicleLoans.id, loanId));
  if (!loan) return null;
  const rows = await tx.select().from(loanScheduleLines).where(eq(loanScheduleLines.loanId, loanId)).orderBy(asc(loanScheduleLines.seq));
  const lines: LoanLine[] = rows.map((r) => ({
    seq: r.seq,
    dueDate: r.dueDate as IsoDate,
    opening: r.openingBalanceCentavos,
    principal: r.principalCentavos,
    interest: r.interestCentavos,
    payment: r.paymentCentavos,
    closing: r.closingBalanceCentavos,
  }));
  const payments = await tx.select().from(loanPayments).where(eq(loanPayments.loanId, loanId)).orderBy(asc(loanPayments.paidOn), asc(loanPayments.createdAt));
  const reversed = new Set(payments.map((p) => p.reversesPaymentId).filter(Boolean));
  const totalPaid = sum(payments.map((p) => p.amountCentavos));
  const status = applyLoanPayments(lines, totalPaid, asOf);
  const totalDue = sum(lines.map((l) => l.payment));
  return {
    loan,
    lines: status,
    payments: payments.map((p) => ({ ...p, reversed: reversed.has(p.id) })),
    totalPaid,
    balance: totalDue - totalPaid > ZERO ? totalDue - totalPaid : ZERO,
    overdue: sum(status.filter((l) => l.overdue).map((l) => l.payment - l.paid)),
    nextDue: status.find((l) => l.status !== "paid") ?? null,
  };
}

export type LoanAlert = { loan_id: string; lender: string; plate_no: string; due_date: string; amount_due: string; overdue: boolean };

/** Loan installments overdue or due within `days` (for finance alerts). */
export async function loanDueAlerts(tx: Tx, today: IsoDate, days: number): Promise<LoanAlert[]> {
  const until = addDays(today, days);
  const loans = await tx.execute<{ id: string }>(sql`SELECT id FROM public.vehicle_loans WHERE status = 'active'`);
  const out: LoanAlert[] = [];
  for (const { id } of loans) {
    const s = await getLoanStatus(tx, id, today);
    if (!s) continue;
    const [v] = await tx.execute<{ plate_no: string }>(sql`SELECT plate_no FROM public.vehicles WHERE id = ${s.loan.vehicleId}`);
    for (const l of s.lines) {
      if (l.status === "paid" || l.dueDate > until) continue;
      out.push({
        loan_id: id,
        lender: s.loan.lender,
        plate_no: v?.plate_no ?? "",
        due_date: l.dueDate,
        amount_due: (l.payment - l.paid).toString(),
        overdue: l.overdue,
      });
    }
  }
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
}

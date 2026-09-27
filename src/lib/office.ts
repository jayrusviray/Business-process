import { addMonths, type IsoDate } from "./dates";
import { applyBps, ZERO, type Centavos } from "./money";

/**
 * Referral commission (owner, 2026-09-27): a percentage (default 10%) of the
 * referred driver's RTO down payment, payable one month after the contract start.
 */
export function referralCommission(downPayment: Centavos, rateBps: number, contractStart: IsoDate, waitMonths: number) {
  return { amount: applyBps(downPayment, rateBps), payableOn: addMonths(contractStart, waitMonths) };
}

/**
 * Investor share per vehicle per month (owner, 2026-09-27):
 *   share = boundaryDays (22) × the driver's daily boundary rate − the driver's monthly RTO amortization.
 * No percentage split. A negative result is reported as-is and paid as ₱0.00 (flagged for review).
 */
export function investorShare(dailyBoundaryRate: Centavos, monthlyAmortization: Centavos, boundaryDays: number) {
  const computed = dailyBoundaryRate * BigInt(boundaryDays) - monthlyAmortization;
  return { computed, payable: computed > ZERO ? computed : ZERO, negative: computed < ZERO };
}

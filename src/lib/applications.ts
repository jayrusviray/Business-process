import { applyBps, sum, ZERO, type Centavos } from "./money";

export type CommissionRule = { mode: "fixed" | "percent"; amountCentavos: Centavos; rateBps: number; active: boolean };

/**
 * Referral commission for an approved application (spec 4.11): a fixed amount,
 * or a percentage of the application's fees (half-up to the centavo, like the
 * driver referral commission). Null when there is no active rule.
 */
export function applicationCommission(rule: CommissionRule | null | undefined, feesTotal: Centavos): { base: Centavos; amount: Centavos } | null {
  if (!rule || !rule.active) return null;
  if (rule.mode === "fixed") return rule.amountCentavos > ZERO ? { base: feesTotal, amount: rule.amountCentavos } : null;
  if (rule.rateBps <= 0 || feesTotal <= ZERO) return null;
  return { base: feesTotal, amount: applyBps(feesTotal, rule.rateBps) };
}

export type ChecklistState = { required: boolean; documentId: string | null; verifiedAt: Date | string | null };

/** How far a document checklist is. Complete = every required item verified. */
export function checklistProgress(items: readonly ChecklistState[]) {
  const required = items.filter((i) => i.required);
  const verifiedRequired = required.filter((i) => i.verifiedAt).length;
  return {
    total: items.length,
    submitted: items.filter((i) => i.documentId || i.verifiedAt).length,
    verified: items.filter((i) => i.verifiedAt).length,
    required: required.length,
    verifiedRequired,
    complete: verifiedRequired === required.length,
  };
}

/** Fees charged vs paid on an application (void rows excluded). Negative balance = overpaid. */
export function feeBalance(fees: readonly { amount: Centavos; voided: boolean }[], payments: readonly { amount: Centavos; voided: boolean }[]) {
  const charged = sum(fees.filter((f) => !f.voided).map((f) => f.amount));
  const paid = sum(payments.filter((p) => !p.voided).map((p) => p.amount));
  return { charged, paid, balance: charged - paid };
}

/** "Juan Dela Cruz" → first "Juan", last "Dela Cruz"; a single word becomes the last name. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  // Common Filipino surname particles stay with the last name.
  const particles = new Set(["de", "del", "dela", "delos", "los", "las", "la", "san", "sta.", "santa", "sto.", "santo"]);
  let i = parts.length - 1;
  while (i > 1 && particles.has(parts[i - 1].toLowerCase())) i--;
  return { firstName: parts.slice(0, i).join(" "), lastName: parts.slice(i).join(" ") };
}

export type ExpiryLevel = "expired" | "urgent" | "warn" | null;

/** OR/CR, insurance and franchise expiry level (spec 4.2: 30/60 days). */
export function expiryLevel(expiresOn: string | null, today: string, urgentBy: string, warnBy: string): ExpiryLevel {
  if (!expiresOn) return null;
  if (expiresOn < today) return "expired";
  if (expiresOn <= urgentBy) return "urgent";
  if (expiresOn <= warnBy) return "warn";
  return null;
}

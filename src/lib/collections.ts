import { ZERO, type Centavos } from "./money";

export type DayPayment = {
  collectorId: string;
  collectorName: string;
  method: string;
  amount: Centavos;
  voided: boolean;
  remitted: boolean;
};

export type CollectorDay = {
  collectorId: string;
  name: string;
  payments: number;
  collected: Centavos;
  cash: Centavos;
  nonCash: Centavos;
  remitted: Centavos;
  /** Cash still in the collector's hands (to be remitted). */
  unremitted: Centavos;
};

export type DaySummary = {
  collectors: CollectorDay[];
  collected: Centavos;
  cash: Centavos;
  remitted: Centavos;
  unremitted: Centavos;
};

/**
 * Per-collector totals for one business day. Voided payments are left out
 * (a void reverses the money). Cash counts as remitted once it is in a remittance.
 */
export function summarizeDay(payments: readonly DayPayment[]): DaySummary {
  const by = new Map<string, CollectorDay>();
  for (const p of payments) {
    if (p.voided) continue;
    let c = by.get(p.collectorId);
    if (!c) {
      c = { collectorId: p.collectorId, name: p.collectorName, payments: 0, collected: ZERO, cash: ZERO, nonCash: ZERO, remitted: ZERO, unremitted: ZERO };
      by.set(p.collectorId, c);
    }
    c.payments += 1;
    c.collected += p.amount;
    if (p.method === "cash") {
      c.cash += p.amount;
      if (p.remitted) c.remitted += p.amount;
      else c.unremitted += p.amount;
    } else {
      c.nonCash += p.amount;
    }
  }
  const collectors = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  const total = (f: (c: CollectorDay) => Centavos) => collectors.reduce((s, c) => s + f(c), ZERO);
  return {
    collectors,
    collected: total((c) => c.collected),
    cash: total((c) => c.cash),
    remitted: total((c) => c.remitted),
    unremitted: total((c) => c.unremitted),
  };
}

/** Collection rate in basis points (collected ÷ charged), or null when nothing was charged. */
export function collectionRateBps(collected: Centavos, charged: Centavos): number | null {
  if (charged <= ZERO) return null;
  return Number((collected * BigInt(10000)) / charged);
}

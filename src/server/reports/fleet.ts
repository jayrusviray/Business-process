import { sql } from "drizzle-orm";
import type { IsoDate } from "@/lib/dates";
import { installmentsLeft, projectedCompletion } from "@/lib/metrics";
import { ZERO } from "@/lib/money";
import { cashoutQuote, monthlyAmortization, rtoProgress, type RtoTerms } from "@/lib/rto";
import { fleetProfitability } from "@/server/queries/profitability";
import type { ReportDef } from "./types";

export type RtoPortfolioRow = {
  id: string;
  contract_no: string;
  driver: string;
  plate: string;
  status: string;
  start_date: string;
  first_due_date: string;
  price: string;
  down: string;
  term: number;
  posted_debits: string;
  balance: string;
};

/**
 * One SQL pass for every contract's ledger totals; the progress itself comes
 * from the same pure functions as the contract page (src/lib/rto.ts).
 */
export async function rtoPortfolio(tx: Parameters<ReportDef["run"]>[0], opts: { includeClosed: boolean; from?: IsoDate }) {
  const rows = await tx.execute<RtoPortfolioRow>(sql`
    SELECT c.id, c.contract_no, d.last_name || ', ' || d.first_name AS driver, v.plate_no AS plate, c.status::text,
      c.start_date::text, c.first_due_date::text, c.contract_price_centavos::text AS price, c.down_payment_centavos::text AS down,
      c.term_months AS term,
      COALESCE(SUM(e.amount_centavos) FILTER (WHERE e.amount_centavos > 0 AND e.entry_type <> 'reversal'
        AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id)), 0)::text AS posted_debits,
      COALESCE(SUM(e.amount_centavos), 0)::text AS balance
    FROM public.rto_contracts c
    JOIN public.drivers d ON d.id = c.driver_id
    JOIN public.vehicles v ON v.id = c.vehicle_id
    LEFT JOIN public.ledger_entries e ON e.account_id = c.account_id
    WHERE ${opts.includeClosed ? sql`(c.closed_on IS NULL OR c.closed_on >= ${opts.from ?? "1900-01-01"}::date)` : sql`c.status = 'active'`}
    GROUP BY c.id, d.id, v.id
    ORDER BY c.contract_no`);
  return rows.map((r) => {
    const terms: RtoTerms = {
      contractPrice: BigInt(r.price),
      downPayment: BigInt(r.down),
      termMonths: r.term,
      startDate: r.start_date as IsoDate,
      firstDueDate: r.first_due_date as IsoDate,
    };
    const posted = BigInt(r.posted_debits);
    const netCredits = posted - BigInt(r.balance);
    return { row: r, terms, posted, netCredits };
  });
}

export const rtoPortfolioReport: ReportDef = {
  key: "rto-portfolio",
  title: "RTO Portfolio Report",
  description: "Rent-to-own contracts: % paid, remaining principal, arrears, installments behind and projected completion.",
  group: "Fleet",
  roles: ["owner_admin", "finance", "operations"],
  defaultRange: "today",
  rangeKind: "as_of",
  landscape: true,
  params: [
    {
      key: "status",
      label: "Contracts",
      default: "active",
      options: [
        { value: "active", label: "Active" },
        { value: "all", label: "All (incl. closed)" },
      ],
    },
  ],
  columns: [
    { key: "contract", label: "Contract", type: "text" },
    { key: "driver", label: "Driver", type: "text" },
    { key: "plate", label: "Vehicle", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "price", label: "Price", type: "money", total: true },
    { key: "paid", label: "Paid", type: "money", total: true },
    { key: "pct", label: "% paid", type: "pct" },
    { key: "remaining", label: "Remaining", type: "money", total: true },
    { key: "arrears", label: "Arrears", type: "money", total: true },
    { key: "behind", label: "Installments behind", type: "int", total: true },
    { key: "scheduled", label: "Scheduled end", type: "date" },
    { key: "projected", label: "Projected end (at pace)", type: "date" },
  ],
  async run(tx, { to, params }) {
    const list = await rtoPortfolio(tx, { includeClosed: params.status === "all" });
    return {
      rows: list.map(({ row, terms, posted, netCredits }) => {
        const p = rtoProgress(terms, netCredits, to);
        const q = cashoutQuote(terms, posted, netCredits);
        return {
          contract: row.contract_no,
          driver: row.driver,
          plate: row.plate,
          status: row.status,
          price: terms.contractPrice,
          paid: p.paid,
          pct: Number((p.paid * BigInt(10000)) / terms.contractPrice),
          remaining: p.remaining,
          arrears: q.arrears,
          behind: p.installmentsBehind,
          scheduled: p.scheduledCompletion,
          projected: row.status === "active" ? projectedCompletion(p.paid, p.remaining, terms.startDate, to) : null,
          left: installmentsLeft(p.remaining, monthlyAmortization(terms)),
        };
      }),
      notes: [
        "Paid = net amount credited to the contract's amortization account (no interest: every peso reduces the principal). Arrears = installments due so far and not yet paid.",
        "Projected end is information only: the remaining balance at the driver's average pace since the contract start.",
      ],
    };
  },
};

export const vehicleReport: ReportDef = {
  key: "vehicle",
  title: "Vehicle Report",
  description: "Per vehicle: boundary and RTO collected vs maintenance/expenses, loan amortization and investor share.",
  group: "Fleet",
  roles: ["owner_admin", "finance"],
  defaultRange: "this_month",
  landscape: true,
  columns: [
    { key: "plate", label: "Vehicle", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "boundary_charged", label: "Boundary due", type: "money", total: true },
    { key: "boundary_collected", label: "Boundary collected", type: "money", total: true },
    { key: "amortization_collected", label: "RTO collected", type: "money", total: true },
    { key: "expenses", label: "Maintenance & expenses", type: "money", total: true },
    { key: "loan_paid", label: "Loan amortization", type: "money", total: true },
    { key: "investor_share", label: "Investor share", type: "money", total: true },
    { key: "net", label: "Net", type: "money", total: true },
  ],
  async run(tx, { from, to }) {
    const rows = await fleetProfitability(tx, from, to);
    return {
      rows: rows
        .map((r) => {
          const n = (k: keyof typeof r) => BigInt(r[k] as string);
          return {
            plate: r.plate_no,
            type: r.powertrain.toUpperCase(),
            status: r.status,
            boundary_charged: n("boundary_charged"),
            boundary_collected: n("boundary_collected"),
            amortization_collected: n("amortization_collected"),
            expenses: n("expenses"),
            loan_paid: n("loan_paid"),
            investor_share: n("investor_share"),
            net: n("boundary_collected") + n("amortization_collected") - n("expenses") - n("loan_paid") - n("investor_share"),
          };
        })
        .filter((r) => r.boundary_charged !== ZERO || r.amortization_collected !== ZERO || r.expenses !== ZERO || r.loan_paid !== ZERO || r.investor_share !== ZERO),
      notes: [
        "Collected = the paid part of dues falling due in the period for the vehicle on each charge (payments apply oldest-first). Same definitions as the vehicle page.",
        "RTO collected is the driver buying the unit (principal), shown as income as on the vehicle page. Investor share: months in the period (draft or paid).",
      ],
    };
  },
};

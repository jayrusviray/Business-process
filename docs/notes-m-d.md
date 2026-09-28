# M-D: cash book, dashboards, reports (notes to fold into the proposal)

## Status

Done: cash book (tables, read model, screens, reconciliation, transfers, moves, routing), the three dashboards with charts and the expiring-papers card, all 15 reports with Excel/PDF/CSV/print, investor statement PDF (staff and portal), the optional nightly email, the performance work and measurements. Not done: see "What's left" at the end.

## Cash book (spec 4.15)

**Tables** (`src/db/schema/cashbook.ts`, migrations `cashbook` + `cashbook_security`):
- `cash_accounts`: Cash on hand, GCash, Maya, BDO bank, Other (seeded). Each can be tied to one payment method (`cash`, `gcash`, `maya`, `bank_transfer`, `other`), which routes records to it. No stored balance; an opening balance is a dated manual entry.
- `cash_transactions`: manual entries for what no module records: opening balance, platform/partner revenue, investor capital, owner capital, other in; owner withdrawal, other out; transfers (one row, shown as two legs). Void-only with a reason (`app.guard_void_only`), no delete, audited.
- `cash_reconciliations`: account, as-of date, counted amount, and the book balance, which **the database computes** in a trigger (`app.cash_balance`), so a client can't supply its own figure. Immutable; a recount is a new row. The screen flags a reconciliation when records dated on or before it changed later.
- `cash_reassignments`: moves one module record to another account (e.g. a loan payment actually paid from GCash). Append-only; the latest row wins; the record itself is never touched.
- RLS: owner/admin and finance only (the views also check the role once per query). `anon` has nothing.

**Read model.** `v_cash_book` (one row per leg, with names, for listing) and its lean twin `v_cash_movements` (one row per movement, for balances and totals). A DB test checks they give the same balance per account. `amount_centavos` is always positive with a `direction`; balance = `SUM(signed_centavos)`.

**How each source maps** (voided/reversed rows never count):

| Source | In/out | Category | Date | Account routing |
|---|---|---|---|---|
| Driver `payments` (not in `payment_voids`), one row per `payment_lines` account | in | Boundary / RTO amortization (incl. cashouts) / Driver costs & deposits | business_date | payment method |
| `application_payments` (not voided) | in | Documentation & activation fees | received_on | payment method |
| `application_fees` | — | not cash (a fee billed); used in the sales/application reports | — | — |
| `commissions_received` (not voided) | in | Commissions received | received_on | setting |
| `referral_commissions`, `application_commissions` with status paid | out | Commission payouts | paid_on | setting |
| `investor_payouts` paid (payable > 0) | out | Investor payouts | paid_on | setting |
| `loan_payments` (a corrected payment and its correction both drop out) | out | Vehicle loan amortization | paid_on | setting |
| `expenses` (not voided), paid_via ≠ cash_advance | out | Expenses, or Payroll when paid_via = payroll | expense_date | paid_via (check → setting) |
| `expenses` paid_via = cash_advance | — | excluded: the cash left when the advance was given | — | — |
| `cash_advances` (not voided) | out | Cash advances given | given_on | setting |
| `cash_advance_settlements` cash_return | in | Cash advances returned | settled_on | setting (as advances) |
| `cash_advance_settlements` payroll_deduction, only once that payroll is **paid** | in | Cash advances returned | settled_on (= pay date) | setting (as payroll) |
| `bonus_awards` paid in cash (not voided) | out | Driver bonuses (cash) | paid_on | setting |
| `cash_transactions` | as category | as entered | entry_date | as entered |

Assumptions (documented, not money rules):
- **Payroll outflow** = the payroll expense booked by "Mark paid" (gross + employer contributions, staff reimbursements, 13th month) on the pay date, as instructed. Because that figure is gross, a cash advance deducted from salary would otherwise be counted twice (once when the advance was given, once inside gross pay). The deduction is therefore shown as money coming back on the pay date. Government remittances (employee + employer shares, withholding tax) are not tracked separately; they are inside the payroll figure. "Other deductions" are assumed to be paid on to third parties.
- **Cash on hand includes cash still with collectors.** A driver's cash payment counts on its business date. Remittances are internal hand-overs and are not cash in/out. The cash book shows how much is not yet remitted next to Cash on hand, and the reconcile form says so.
- **Cashouts** are ordinary payments on the amortization account, so they appear under "RTO / amortization (incl. cashouts)".
- **Routing of records without a payment method** (payroll, loan payments, investor payouts, commission payouts, commissions received, cash advances, cash bonuses, and expenses paid by check) comes from setting `cashbook.default_routing`. Defaults: advances and cash bonuses → Cash on hand; checks → the bank account; everything else → **Other**, until the owner decides (open question). Owner/admin can change it on Cash book → Accounts & routing.
- **Transfers and opening balances** are not counted as money in or out in period totals (the business doesn't gain or lose money), but they count in each account's balance.

## Dashboards (spec 5)

`/app` shows, by role (RLS also limits every number):
- **Business performance** (owner/admin): today (boundary expected vs collected, rate, drivers unpaid today), period (collections, revenue by service line, expenses, net cash flow), outstanding balances with aging, fleet (active/idle/maintenance, EV/ICE/hybrid), RTO portfolio (active, receivable, arrears, nearing completion), upcoming payables (loan dues, recurring bills, payroll), applications, CRM, and the two trend charts.
- **Collections** (owner/admin, finance, operations): today, due-today list, top overdue drivers, pending payment proofs (owner/finance), collector cash and remittance differences, daily trend.
- **Sales** (owner/admin, sales, documentation): revenue by service line (sales/documentation see application fees only), documentation fees and activations by type, lead funnel and agent performance (roles that can read leads).
- The existing finance and driver alert cards stay; a new **Expiring papers** card (OR/CR, insurance, franchises; urgent vs warn from `expiryLevel`) is shown to owner/admin, finance, operations and sales.

Definitions:
- Collection rate = boundary collected that day ÷ boundary due that day (basis points). Late payments count when received, so it can exceed 100%. Same function as Close the day (`collectionRateBps`).
- Aging uses what is still open after oldest-first allocation, bucketed 1–7, 8–15, 16–30, over 30 days past due (setting `dashboard.aging_bucket_days`).
- Revenue is cash received (driver collections by account, application fees by service line, commissions received, manual platform revenue). Capital, transfers and cash-advance returns are not revenue.
- RTO "nearing completion" = remaining principal ≤ N monthly installments (setting, default 3). "Projected completion" in the RTO report is information only: the remaining balance at the driver's average pace since the contract start.
- Charts follow the dataviz method: one peso axis, blue/orange validated for colour-blind separation and contrast in light and dark, legend + hover tooltip + a "Show data" table under each chart. Single-series bars are server-rendered HTML with every value printed.

## Reports (spec 6)

A small framework (`src/server/reports/*`): a definition = key, title, roles (matching RLS), default date range, parameters (fixed or loaded, e.g. drivers, investors, payroll runs), typed columns (`text/money/int/date/pct`), and a query run as the user. One page `/app/reports/[key]` (filters, table with totals, notes, print) and one export route `/app/reports/[key]/export?format=xlsx|pdf|csv`. Money stays bigint to the last step: Excel gets numbers via the exact decimal string, totals are summed in centavos (not Excel formulas), PDFs print "PHP", CSV has a BOM and neutralises formula injection. Three reports reuse existing documents: the Driver Statement PDF, the Payroll Register Excel (when one run is chosen) and the new investor statement PDF.

Roles: collections reports for owner/admin, finance, operations; money reports (sales, expenses, payroll, commissions, investors, cash flow, vehicle) for owner/admin and finance; application report also for operations, sales and documentation; CRM report for owner/admin, operations and sales.

## Investor statement (spec 4.12)

One page per investor per month: each vehicle's 22 × daily boundary − driver's monthly RTO amortization, the payable amount (negative months paid as ₱0.00 and flagged), paid/pending, and totals. It is exactly the `investor_payouts` rows; no deductions or management fee. Investors download it from the portal (their rows only, by RLS; driver names show as "Assigned driver" because investors can't read driver records). Staff get it from the Investors page or the report.

## Nightly email (optional)

`/api/cron/daily-report` (21:00 Manila, `vercel.json`) emails the Daily Collection Report with the Excel attached. It does nothing unless setting `reports.daily_email_to` has addresses **and** `RESEND_API_KEY` + `REPORTS_EMAIL_FROM` are set. The provider interface (`src/server/email/provider.ts`) has a no-op default and a Resend adapter using `fetch`.

## Performance (NFR: dashboards < 2 s with 500 drivers × 3 years)

`scripts/perf/seed.ts` rebuilds a test database with 500 drivers, 520 vehicles, 934k ledger entries, 455k payments, 200 RTO contracts, 100 loans, 20 investors, 9k expenses, 4k applications, 12k leads. `scripts/perf/measure.perf.ts` (Vitest config in `scripts/perf/`) times every dashboard section and report as the owner through `withUserTx`, i.e. with RLS.

What it took:
1. **RLS policies evaluated their role check per row.** On the ledger, `app.has_any_role()` alone cost ~10 s per query (a 934k-row balance sum took 10.1 s; 0.2 s without RLS). The read policies of the large tables now wrap row-independent calls in a sub-select (`(SELECT app.has_any_role(...))`), which Postgres evaluates once per query. Same rules and results; the existing RLS tests pass. **This alters existing policies** (in the `cashbook_security` migration), listed there.
2. **`app.open_charges(as_of)`**: open dues with the same oldest-first rule as `v_charge_status`, computed from the other end (an account's balance is what its newest debits still owe), walking a new partial index newest-first and stopping when covered. ~0.9 s vs `v_charge_status` 2.8 s for everything. A DB test checks it against `v_charge_status`, including partial payments, voids and reversed charges. The existing driver/finance alert cards now use it (same results; one pass instead of one allocation per contract/loan).
3. Lean `v_cash_movements` for balances (0.4 s vs 3.9 s for the detailed view), indexes for date-range reports, month-level revenue trend, hashed unremitted-cash lookup, and explicit PDF pagination (react-pdf's automatic splitting was quadratic: 2,000 rows took 68 s, now 5 s).

Measured (warm, this container, sections in parallel as on the page):

| Page / report | Time |
|---|---|
| Business performance dashboard | 1.2–1.4 s (slowest section: open dues + aging) |
| Collections dashboard | 1.1–1.4 s |
| Sales dashboard | 0.25–0.3 s |
| Cash book page (month) | 1.6 s |
| Reports (default ranges) | all ≤ 1.6 s; aging 1.2–1.6 s, vehicle 1.0–1.2 s, the rest ≤ 0.25 s |
| PDF export | ~2.5 ms/row (500 rows ≈ 1.2 s) |

Not tuned (outside M-D, still use `v_charge_status` and will be slow at this volume): the drivers list (`listDrivers`, one view evaluation per driver), Collect today, and the vehicle profitability page. They can switch to `app.open_charges` the same way.

## What's left / follow-ups

- Nothing in the M-D scope is unfinished. Follow-ups: the slow existing screens above; a visual pass of the new screens with real data (charts were checked in light and dark on a preview; the report and cash book screens were exercised through the build, typecheck and tests, not by hand).
- `next build` with Turbopack fails in this worktree only because `node_modules` is a symlink outside the project root; `next build --webpack` passes.

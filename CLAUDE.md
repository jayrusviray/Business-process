@AGENTS.md

# TransRev Operations System

Internal operations system for TransRev (TNVS franchise documentation, platform activation, and vehicle programs: boundary / boundary-hulog / RTO). It replaces the spreadsheets. Design and business rules: `docs/00-phase0-proposal.md` (§6 lists the owner-confirmed rules, §7 the open ones). **Never guess a business rule that affects money. Ask.**

## Stack
- Next.js 16 App Router + TypeScript strict. **Next 16 differs from older versions.** Read `node_modules/next/dist/docs/` before using an API. Notable changes: `middleware.ts` is now `src/proxy.ts`; `params`, `searchParams`, `cookies()` and `headers()` are async; global `PageProps<"/route">` and `LayoutProps` types come from `next typegen`.
- Supabase (Auth, Postgres, Storage). Drizzle ORM for the schema and queries. Zod v4 at every boundary.
- Tailwind v4 with shadcn-style components in `src/components/ui` (hand-written, no generator).
- Vitest for tests: the `unit` project covers `src/**/*.test.ts`, the `db` project covers `test/db/**/*.test.ts` against a real Postgres.

## Commands
```
npm run dev            # local app (needs .env.local, see .env.example)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # unit tests
npm run test:db        # DB integration tests (needs TEST_DATABASE_URL; rebuilds that DB from scratch)
npm run test:all       # both
npm run db:generate    # drizzle-kit: SQL migration from schema changes
npx drizzle-kit generate --custom --name <x>   # hand-written SQL migration (RLS, triggers, functions, seeds)
npm run db:migrate     # apply ./drizzle migrations to DATABASE_URL
```
Local DB tests: a Postgres 16 with user `postgres`/`postgres` and database `transrev_test`. `test/db/supabase-stub.sql` imitates Supabase's `auth` schema and roles.

## Layout
- `src/app/(auth)`: login. `src/app/(staff)/app`: staff back office. `src/app/(portal)/portal`: driver/investor portal (mobile-first). Later phases add public routes: `/school`, `/apply`.
- `src/db/schema/*`: Drizzle tables. `drizzle/`: versioned migrations. Never edit an applied migration; add a new one.
- `src/db/client.ts`: `withUserTx` and `withSystemTx` (see Security).
- `src/lib/money.ts`, `src/lib/dates.ts`: the only way to handle money and business dates.
- `src/lib/settings/*`: the Zod registry for `app_settings` and government table configs.
- `src/lib/nav.ts`: staff navigation and module roles (single source of truth). Bump `CURRENT_PHASE` when a phase ships.
- `src/server/money/*`: money services (charges, payments, fleet, RTO, loans). `src/server/office/*`: expenses, payroll, commissions, investors. `src/server/queries/*`: read models for screens. `src/server/pdf/*`, `src/server/xlsx/*`: exports.
- `src/lib/payroll.ts`: all payroll math (pure, exact integer arithmetic). Rates come from settings and the versioned government tables.

## Money rules (non-negotiable)
1. **Integer centavos, always.** DB columns are `bigint` (`*_centavos`), and TS uses the `bigint` type (`Centavos`). Never use `number` or `parseFloat` for money. Parse input with `parsePeso`, display with `formatPeso`. Rates are basis points; use `applyBps` / `divRound`, where rounding is explicit.
2. **Split amounts with `allocateByWeights`** so the parts sum exactly to the total.
3. **Ledger, not balances.** A balance is always `SUM(amount_centavos)` over append-only ledger entries. A cached balance is allowed only if it is rebuildable from the ledger.
4. **No UPDATE or DELETE on financial rows.** Guard every ledger/financial table with `app.forbid_mutation()`. Corrections are reversal/adjustment entries that reference the original and carry `reason` and `created_by`.
5. **Every money job is idempotent.** Use unique idempotency keys (e.g. `charge:{plan}:{date}`) and catch up on missed days.
6. **Concurrent postings for one driver are serialized** with `pg_advisory_xact_lock` inside the transaction.
7. **Every money calculation is a pure function with Vitest tests**, including edge cases (partial payment, overpayment, reversal, month-end).

## Ledger model (Phase 2)
- **`driver_accounts`:** `boundary`, `amortization`, `charges` (costs at cost + the non-refundable deposit). **Payments never move between accounts on their own.** The collector splits each payment (`payment_lines`).
- **`ledger_entries`:** append-only, signed centavos, ordered by `(due_date, seq)` for allocation. The DB enforces the sign by entry type, due dates on debits, reasons on adjustments/reversals, and account/type matching. Reversals must be the exact opposite amount on the same account.
- **Allocation (oldest due first) is computed, never stored:** `allocateAccount()` in TS, `v_charge_status` in SQL. They must stay identical; `test/db/money.test.ts` checks this.
- **Daily charges:** `runDailyCharges()` (cron `/api/cron/daily-charges`, 00:05 PHT) posts from the day after the last successful run up to today. The idempotency key is `boundary:{plan}:{date}`. It skips holidays and non-active drivers.
- **Services** in `src/server/money/*` take a `Tx` and are called inside `withUserTx`, so RLS still applies. They lock per driver with `lockDriver()`.

## Dates
Business dates are `Asia/Manila` calendar dates (`IsoDate` "YYYY-MM-DD", Postgres `date`). Use `businessToday()` / `toBusinessDate()`. Never use `new Date().toISOString().slice(0,10)`: that gives the UTC date, which is wrong from 00:00 to 07:59 PHT. For monthly schedules, use `addMonths(d, n, anchorDay)` so due dates don't drift after a month-end clamp.

## Security
- **RLS is the real gate.** Every `public` table has RLS enabled; a test fails if one doesn't. `anon` has no privileges. UI role checks (`requireRole`, `nav.ts`) are only for convenience.
- The Drizzle connection role **bypasses RLS**, so the raw `db` is never exported:
  - User requests: `withUserTx(session.claims, tx => …)` sets `request.jwt.claims` and `SET LOCAL ROLE authenticated`.
  - Cron and webhooks: `withSystemTx("cron:job-name", tx => …)`. RLS is bypassed and the label is written to the audit log.
- Role helpers in SQL: `app.has_role(r)`, `app.has_any_role(...)`, `app.is_staff()`. A disabled profile has no effective roles.
- **Audit:** attach `app.audit_row_change()` (AFTER INSERT/UPDATE/DELETE) to every financial, payroll and driver table. Pass the primary key column(s) as arguments when the PK is not `id`. Use `app.stamp_row()` for `created_by` / `updated_by` / `updated_at`.
- **jsonb writes use `jsonb(value)` from `src/db/sql.ts`.** A plain JS `null` becomes SQL NULL.
- **Documents (Data Privacy Act):** files live in the private `documents` bucket. Before issuing a short-lived signed URL, check visibility with an RLS query as the user, then insert into `document_access_log`.
- The Supabase admin client (secret key) is only for auth admin tasks and storage signing, and only after an RLS-checked permission check.

## Conventions
- **Server Actions:** `requireRole` first, then parse `FormData` with Zod, then `withUserTx`. Return `{ ok } | { error }` and use `ActionForm` to display it. Map DB errors to friendly messages; never leak SQL.
- **Configurable, not hardcoded.** Rates, quotas, bonuses, government tables, templates and thresholds belong in settings tables. To add a setting: add it to `src/lib/settings/registry.ts` **and** seed it in a migration with `ON CONFLICT DO NOTHING`. A test enforces both.
- **Government tables are versioned by `effective_from`.** Add a new version instead of editing an old one.
- **Mobile-first** for anything collectors or drivers use: large touch targets, `text-base` inputs (so iOS doesn't zoom), no hover-only UI.
- **Money is shown right-aligned** with the `.money` class (tabular numbers).

## Build phases
1. ✅ Foundation: auth, roles, RLS, audit log, settings, app shell, seeds.
2. ✅ Money engine: drivers, vehicles, boundary plans, ledger, daily charges, payments, allocation, bulk entry, remittance.
3. ✅ Driver dashboard, portal (mobile + password login), quotas and bonuses, statement PDF.
4. ✅ RTO contracts (no interest, price ÷ term) and cashout, vehicle loan schedules (diminishing balance), per-vehicle profitability, finance alerts.
5. ✅ Reminders: daily outbox, sent manually from staff phones (no SMS gateway yet), EN/Taglish templates, schedules, log, opt-outs. Provider interface kept for a future gateway.
6. ✅ Expenses (budgets, recurring bills), payroll (semi-monthly, Labor Code defaults in settings, payslip PDF, register XLSX, cash advances, 13th month), commissions (referral 10% of down payment after 1 month; received), investor share (22 × daily boundary − driver's monthly RTO amortization).
7. Applications, CRM, school landing page.
8. Reports, business dashboard, exports.
9. Spreadsheet import, hardening, Playwright, deployment docs.

# M-E notes (spreadsheet import, demo seed, Playwright, hardening, deployment docs)

## Status / what's left (paused 2026-09-28)

**Done (committed, all checks green: typecheck, lint, 200 unit tests, 119 DB tests):**
- Schema `src/db/schema/imports.ts`: `import_batches` (append-only; unique `(kind, file_sha256)` so the same file imports once) and `legacy_payments` (reference-only, never touches the ledger).
- Migrations `drizzle/0019_imports.sql` (generated) and `drizzle/0020_imports_security.sql` (RLS: batches owner_admin only; legacy payments readable by owner_admin/finance/operations, insert owner_admin; append-only + audit + stamp triggers; batch-kind check trigger).
- Pure parsing `src/lib/imports/cells.ts` (Excel numbers without float noise, Excel serial dates incl. 1904 system, PH date formats, peso text incl. `P`/`PHP`/parentheses), `kinds.ts` (kinds in import order, column specs + aliases, header matching), `rows.ts` (row validators per kind, in-file duplicate checks). Unit tests: `cells.test.ts`, `rows.test.ts`.
- File reader `src/server/imports/read.ts` (CSV with real line numbers + Windows-1252 fallback; .xlsx first sheet via exceljs; 5 MB / 2,000-row limits) + `read.test.ts`.
- Service `src/server/imports/service.ts` (`runImport`: validate all rows → preview; commit only if every row is valid; per-kind planners for vehicles, drivers, boundary plans + vehicle assignment, RTO contracts, opening balances, legacy payments, employees, investors, leads via CRM). Opening balances use `entry_type 'opening_balance'` + idempotency key `import:{batch}:{line}`; an account that already has a non-reversed opening balance is refused.
- Small backward-compatible hooks: `postAdjustment` gains optional `idempotencyKey`/`memo`; `createRtoContract` gains `openingCreditKey`; `importLeadsCsv` split into `importLeadRows` (reused by the wizard); `parseCsvLines`/`normalizeHeader` in `src/lib/csv.ts`.
- CSV templates for every kind in `public/templates/` (a unit test checks their headers match the specs).

**Not done yet (next session, in this order):**
1. `docs/import-samples/*` sample files (one as .xlsx) + `test/db/imports.test.ts` (end-to-end import in order; balances = SUM(ledger); re-import refused; RLS on the new tables).
2. UI `/app/import` (page, server action with preview/import, batch history) + replace `/app/m/import` in `src/lib/nav.ts`; "Payments before go-live" card on the driver page (`listLegacyPayments` exists).
3. Demo seed (`src/server/demo/seed.ts`, `scripts/seed-demo.ts`, `npm run db:seed:demo -- --yes`) + `test/db/seed.test.ts`.
4. Hardening: security headers in `next.config.ts`, `error.tsx`/`not-found.tsx`/`global-error.tsx`, `GET /api/health` (public in `src/proxy.ts`), `scripts/bootstrap-admin.ts`.
5. Playwright (`playwright.config.ts`, `e2e/`, `npm run test:e2e`), `docs/DEPLOYMENT.md`, open questions in `docs/OPEN_QUESTIONS.md`.

## Decisions / assumptions so far
- Entity imports (vehicles by plate, drivers by mobile, employees by number, investors by name) **skip** existing records instead of updating them; the preview shows "already exists".
- Boundary plans can't start before today (default start = date chosen on the form); opening balances and legacy payments use an as-of date ≤ today.
- RTO "paid to date" = everything paid toward the vehicle before go-live, including the down payment; posted as one opening credit. `first_due_date` is required (not guessed).
- Slashed dates are read month-first (PH/US Excel default) unless the first number is over 12.
- Lead imports reuse the CRM logic unchanged, so they still notify agents per new lead (possible open question: silence bulk imports?).

# M-E notes: spreadsheet import, demo data, Playwright, hardening, deployment

## Status
All five parts are done: import (with UI), sample files and an end-to-end import test, demo seed, hardening, and Playwright plus the deployment docs. Open questions are rows 19–26 in `docs/OPEN_QUESTIONS.md`.

## What was built
- **Import tables** (`src/db/schema/imports.ts`; migrations `0019_imports.sql` and `0020_imports_security.sql`):
  - `import_batches`: append-only; the same file (by SHA-256) can be imported once per kind; RLS owner_admin only.
  - `legacy_payments`: reference only and append-only; readable by owner_admin, finance and operations.
- **Parsing** (`src/lib/imports/*`, pure, unit-tested):
  - Excel numbers without float noise, Excel serial dates (1900 and 1904 systems), PH date formats, and peso text (`P`, `PHP`, `₱`, parentheses).
  - Header aliases per kind, and row validators that also catch duplicates inside a file.
- **Reader** (`src/server/imports/read.ts`): CSV with real line numbers and a Windows-1252 fallback, or the first sheet of an .xlsx. Limits: 5 MB and 2,000 rows.
- **Service** (`src/server/imports/service.ts`, `runImport`): previews every row, and commits in one transaction as the owner (RLS applies) only when there are no errors.
- **Import screen** at `/app/import` (nav entry replaces `/app/m/import`): steps in order, templates, column help, preview then import, and batch history. The driver page gets a "Payments before go-live" card.
- **Templates**: `public/templates/*.csv` and `*.xlsx` (the xlsx files have an Instructions sheet). `npm run import:files` regenerates the xlsx files and `docs/import-samples/02-drivers.xlsx`.
- **Demo seed**: `src/server/demo/seed.ts` and `scripts/seed-demo.ts` (`npm run db:seed:demo -- --yes`).
- **Hardening**:
  - security headers and CSP in `next.config.ts`
  - `error.tsx`, `not-found.tsx` and `global-error.tsx`, plus an error page inside the staff area
  - `GET /api/health` (public)
  - `scripts/bootstrap-admin.ts` (`npm run admin:bootstrap`)
- **Playwright**: `playwright.config.ts`, `e2e/` and `npm run test:e2e`.
- **Docs**: `docs/DEPLOYMENT.md`.

## Decisions and assumptions
- **Existing records are skipped, never updated.** Vehicles are matched by plate (ignoring spaces and dashes), drivers by mobile, employees by number and investors by name. The preview says "already exists".
- **One opening balance per account.** An account that already has a non-reversed opening balance is refused. This covers manual ones and the RTO paid-to-date credit, so a second file or amortization rows for contract drivers can't double-count. Several rows per account in one file are allowed (to keep the aging).
- **Import keys.** Opening balances and RTO paid-to-date credits carry the idempotency key `import:{batch}:{line}`.
  - Small, backward-compatible additions made this possible: `postAdjustment` gained `idempotencyKey`/`memo`, and `createRtoContract` gained `openingCreditKey`.
  - The lead import was split into `importLeadRows`, which the import screen reuses. The CRM import behaves as before.
- **Dates.** Plans can't start before today (the default start is the date chosen on the form). Opening balances and legacy payments use an as-of date that can't be in the future.
- **RTO contracts.**
  - "Paid to date" means everything paid toward the vehicle before go-live, including the down payment.
  - `first_due_date` is required, not guessed.
  - Installments due so far are posted by the existing `createRtoContract`, using the real import date as today.
- **Leads** go through the CRM logic unchanged, so agents are notified per new lead (open question 25).
- **Demo seed.**
  - It runs as the system, one transaction per day, through the real services.
  - It needs an existing staff user as collector; it never creates auth users.
  - Its rows are marked `[demo]` in notes, and it refuses to run twice.
  - It records a `charge_runs` row, so the daily job continues from the next day.
- **CSP** uses no nonces (`'unsafe-inline'` scripts and styles), so pages don't all have to render dynamically. Playwright checks that no CSP violations or page errors occur.
  - HSTS: no `preload`.
  - Permissions-Policy blocks the camera, microphone, geolocation, payment and USB APIs. Receipt photos use the file input with `capture`, which still works.
- **Shared test database.** The import and seed DB tests retire the employees and investor links they create in `afterAll`, because `office.test.ts` assumes it owns every active employee and investor vehicle.
- **Turbopack build.** Turbopack refuses to build in a worktree whose `node_modules` is a symlink. For local e2e runs here, use `E2E_NEXT_BUILD_FLAGS=--webpack`. Normal checkouts are unaffected.

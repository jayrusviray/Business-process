# TransRev Operations System

Internal operations system for TransRev. See `CLAUDE.md` for architecture and conventions, and `docs/00-phase0-proposal.md` for the design and confirmed business rules.

## Setup
1. `npm install`
2. Create a Supabase project. Copy `.env.example` to `.env.local` and fill it in.
3. `npm run db:migrate` applies the schema, security policies and default settings.
4. Create the first owner/admin:
   - Invite yourself via Supabase Dashboard → Authentication.
   - Then run `npm run admin:bootstrap -- --email you@example.com --yes`.
   - For development only, `SEED_PASSWORD=... npm run db:seed:dev -- --yes` creates one demo user per role, and `npm run db:seed:demo -- --yes` adds 60 days of demo data.
5. `npm run dev`

## Tests
- `npm test` runs the unit tests (money, dates, roles/navigation).
- `npm run test:db` runs the database integration tests (RLS, audit, append-only, settings) against `TEST_DATABASE_URL`. That database is **dropped and rebuilt** on every run.
- `npm run test:e2e` runs the Playwright end-to-end tests (see `docs/DEPLOYMENT.md` §9).

Deployment, spreadsheet import and the operations runbook: `docs/DEPLOYMENT.md`.

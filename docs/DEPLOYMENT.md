# Deployment and operations

How to stand up TransRev in production (Supabase + Vercel), bring in the old spreadsheets, and run it day to day.

## 1. Supabase project

1. Create a project in the **Southeast Asia (Singapore)** region (closest to Manila). Use a strong database password and keep it in a password manager.
2. **Plan and backups.** Use a paid plan: it has daily backups. Turn on **Point-in-Time Recovery** (Settings → Add-ons) so you can restore to any minute. The ledger is append-only, but PITR is what saves you from a bad import or a mistaken bulk change.
3. **Authentication** (Authentication → Providers / Sign In):
   - **Email** on, with **Confirm email** on. Turn **Allow new users to sign up** off: staff are invited, and drivers get their login from the driver page.
   - **Phone** on, with password sign-in. Drivers sign in with mobile number + password. No SMS provider is needed, because staff hand over the temporary password in person (owner decision: there is no SMS gateway yet).
   - Password: minimum length 10 or more.
   - URL configuration: set **Site URL** to the production domain (for example `https://ops.transrev.ph`) and add it to the redirect URLs.
4. **Storage.** The migrations create the private bucket `documents` (licences, IDs, OR/CR, receipts). Check that it exists and that **Public** is off. Don't add storage policies: files are served only through short-lived signed URLs, issued by the server after an RLS check and logged in `document_access_log`.
5. **Keys** (Settings → API): copy the project URL, the **publishable** key and the **secret** key. The secret key goes only into server environment variables.
6. **Database connection** (Settings → Database → Connection string → *Transaction pooler*, port 6543). This is `DATABASE_URL`. The app connects with `prepare: false`, which the pooler requires.

## 2. Environment variables

Set these in Vercel (Production and Preview) and in `.env.local` for development. See `.env.example`.

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key (safe in the browser). |
| `SUPABASE_SECRET_KEY` | Secret key. Server only: driver logins and signed file URLs. |
| `DATABASE_URL` | Transaction-pooler connection string. Its role bypasses RLS; the app always goes through `withUserTx` for users. |
| `CRON_SECRET` | A long random string (16+ characters). Vercel Cron sends it; the cron routes refuse anything else. |
| `NEXT_PUBLIC_SITE_URL` | The public URL (canonical links, sitemap, Open Graph). |
| `RATE_LIMIT_SALT` | A long random string for hashing visitor IPs (website form rate limit). |
| `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PAGE_ACCESS_TOKEN` | Only for Facebook Lead Ads (section 7). |

## 3. Database migrations

From a checkout of the release you are deploying:

```
DATABASE_URL='postgresql://…pooler.supabase.com:6543/postgres' npm run db:migrate
```

Migrations are in `drizzle/` and run in order, once each. They create the tables, RLS policies, triggers, default settings, holidays and the storage bucket. Run migrations **before** deploying code that needs them. Never edit a migration that has already run; add a new one.

Check after every migration: `/api/health` answers `{"ok":true,"db":"ok"}`.

## 4. The first owner/admin

1. Supabase Dashboard → Authentication → Users → **Invite user** (or **Add user**) with the owner's email.
2. Then:
   ```
   DATABASE_URL='…' npm run admin:bootstrap -- --email owner@example.com --yes
   ```
   The script grants `owner_admin` to that existing user, creating the profile if needed. It refuses if an owner/admin already exists (add `--force` only if you really mean it). Later admins and all other roles are granted in the app under **Admin → Users & roles**.

## 5. Vercel

1. Import the Git repository as a Vercel project (framework: Next.js, build command `npm run build`). Region: **Singapore (sin1)**, next to the database.
2. Add the environment variables from section 2.
3. **Crons** come from `vercel.json`:
   - `/api/cron/daily-charges` at 16:05 UTC = **00:05 Manila**: posts the day's boundary charges and RTO installments, catching up any missed days.
   - `/api/cron/reminders` at 00:00 UTC = **08:00 Manila**: prepares the reminder outbox.
   Vercel sends `Authorization: Bearer $CRON_SECRET`; the routes return 401 without it.
4. **Domain.** Add the domain in Vercel (Settings → Domains), point DNS as Vercel shows, then set `NEXT_PUBLIC_SITE_URL` and the Supabase Site URL to it and redeploy.
5. Security headers (CSP, HSTS, frame blocking and so on) come from `next.config.ts`; there is nothing to configure in Vercel. Uptime monitors can poll `GET /api/health` (public; returns 503 when the database is unreachable).

## 6. Development and demo data

- `npm run dev` with `.env.local` pointing at a **development** Supabase project, never production.
- `SEED_PASSWORD='…' npm run db:seed:dev -- --yes` creates one demo login per role.
- `npm run db:seed:demo -- --yes` then fills the database with demo data: 20 drivers, 15 vehicles (5 EV), boundary and RTO contracts, 60 days of charges and payments (with partial and missed days), remittances, leads, applications, 5 employees and 2 investors. It uses the real services, refuses `NODE_ENV=production`, needs at least one staff user (collector), and refuses to run twice. `--today=YYYY-MM-DD` sets the last day of history.
- The same works on a local Postgres with `test/db/supabase-stub.sql` loaded (as the DB tests do).

## 7. Facebook Lead Ads (optional)

1. Create a Meta app, add the **Webhooks** product, and get app review for `leads_retrieval` (and `pages_manage_metadata`, `pages_show_list`).
2. Subscribe the Page to the `leadgen` field with callback URL `https://<domain>/api/webhooks/meta` and a verify token of your choice.
3. Set `META_APP_SECRET`, `META_VERIFY_TOKEN` (the same token) and `META_PAGE_ACCESS_TOKEN` (a long-lived Page token) in Vercel, then turn on the setting **`crm.meta_lead_ads_enabled`** (Admin → Settings).
4. Each submission is checked against Meta's signature and stored once (keyed on its leadgen id), then assigned like website leads.

## 8. Importing the spreadsheets (go-live)

Screen: **Insights → Import** (`/app/import`, owner/admin only). Every kind has an Excel and a CSV template, a column list, and a preview that checks each row. Nothing is saved unless every row is valid, and the same file can't be imported twice. Worked examples are in `docs/import-samples/`.

Order (each step looks up what the earlier ones created):

1. **Vehicles** (plate, make, model, type EV/ICE/hybrid, expiries, funding).
2. **Drivers** (found later by mobile number, so each mobile must belong to one driver).
3. **Boundary plans**, which also assign the vehicles. Plans start on go-live day or later; they never start in the past.
4. **RTO contracts.** The installments due so far are posted at once, and "paid to date" is posted as one opening credit.
5. **Opening balances** per driver and account (boundary, charges, amortization), as of the cut-off date. Positive = owes, negative = advance. Arrears can be split by month with due dates to keep the aging.
6. **Payments before go-live.** Reference only: they are shown on the driver page and never change a balance.
7. **Employees**, 8. **Investors** (and their vehicles), 9. **Leads**.

Suggested routine:
- Freeze the sheets at the end of the cut-off day (for example Sep 30).
- The evening before go-live: import 1–4 with plans starting on go-live day, then 5–6 as of the cut-off day.
- If you import plans that start *today* after the 00:05 charge run, click **Collections → Charges → Run charges now** so today's boundary is posted.
- Spot-check a few drivers against the sheets (driver page → statements) before collecting.
- A wrong opening balance is fixed with **Reverse** on the driver page (the entry stays, with its reversal and reason). Then import a corrected file for that driver.

Imported opening balances have `entry_type = 'opening_balance'` and an idempotency key `import:{batch}:{line}`, so reports can include or exclude them.

## 9. End-to-end tests

- `npm run test:e2e` builds the app, rebuilds a throwaway database (`E2E_DATABASE_URL`, default `transrev_e2e`; the name must contain "e2e"), starts it on port 3300 (`E2E_PORT`), and runs the public flows on a desktop and a phone viewport: landing page and security headers (no CSP violations), "Ask about this", the inquiry form (consent, thank-you, lead in the DB), `/school`, `/privacy`, the login redirect and `/api/health`.
- Signed-in flows (login → dashboard, record a payment → receipt, new CRM lead) need a real Supabase: run against a deployed preview with demo data:
  ```
  E2E_BASE_URL=https://preview.example.com E2E_STAFF_EMAIL=… E2E_STAFF_PASSWORD=… npm run test:e2e
  ```
  They record a real ₱1.00 payment on the first driver, so use a development project.
- `E2E_NEXT_BUILD_FLAGS=--webpack` builds with webpack (needed where `node_modules` is a symlink, which Turbopack refuses).

## 10. Operations runbook

**Every morning**
- **Collections → Charges**: the latest run should be *succeeded* for today. A failed run shows its error. Fix the cause, then **Run charges now**: it catches up every missed day (up to `collections.charge_catch_up_max_days`) and never posts a day twice.
- Work the **reminder outbox** (from 08:00).
- **Close the day** (finance) after remittances.

**Mistakes and corrections** (the ledger is never edited)
- Wrong payment: **Void** it on the receipt with a reason. The reversal is automatic and the receipt shows VOID.
- Wrong charge or opening balance: **Reverse** the entry on the driver page with a reason, then post the right one.
- Wrong rate: end the plan and start a new version from the next day. Charges already posted at the old rate are reversed one by one if they were wrong.
- Holiday added late: reverse the boundary charges already posted for that day.

**Data-privacy requests (RA 10173)**
- Leads: owner/admin can **export** (JSON) or **erase** a lead from its page. Only the fact of the request is kept (`privacy_requests`).
- Drivers, employees and financial records can't be erased while the law requires keeping them (tax and accounting records). Correct wrong personal data on the record, and record the request in writing.
- Document access is logged per file (`document_access_log`); owner/admin can review it.

**Backups and restores**
- Rely on Supabase daily backups and PITR. Before a big import or any manual SQL, note the time, so you can restore to just before it.
- Restores replace the whole database. Afterwards run **Run charges now** to catch up the days in between.

**Access**
- Remove roles and disable users who leave (Admin → Users & roles). A disabled profile has no permissions even if the login still works.
- Rotate `CRON_SECRET`, `RATE_LIMIT_SALT` and the Supabase secret key if they may have leaked, then redeploy.

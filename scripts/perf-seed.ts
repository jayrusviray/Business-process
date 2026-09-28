/**
 * Performance seed (M-D, NFR "dashboards < 2 s with 500 drivers and 3 years of
 * daily ledger entries"). Rebuilds a TEST database from scratch and bulk-loads:
 *   500 active drivers, 520 vehicles, 3 years of daily boundary charges and
 *   payments (~1M ledger rows), 200 RTO contracts, 100 bank loans, 20 investors,
 *   expenses, payroll, applications, leads, commissions, cash advances.
 *
 * NEVER run it against a real database: it DROPS the target's schemas.
 *   PERF_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/transrev_test_md_perf npx tsx scripts/perf-seed.ts
 * Then time the queries with scripts/perf-measure.ts.
 *
 * Triggers are switched off while loading (session_replication_role = replica)
 * so the audit log doesn't double the volume; the data is generated consistent
 * with every rule the triggers enforce.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { addDays, businessToday } from "../src/lib/dates";

const url = process.env.PERF_DATABASE_URL ?? "";
if (!/\/[^/]*test[^/]*$/.test(url)) {
  console.error("Set PERF_DATABASE_URL to a database whose name contains 'test'. It will be dropped and rebuilt.");
  process.exit(1);
}

const END = businessToday();
const START = addDays(END, -1095);
const DRIVERS = 500;

async function main() {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const t0 = Date.now();
  const step = async (label: string, q: string) => {
    const t = Date.now();
    await sql.unsafe(q);
    console.log(`${label.padEnd(44)} ${((Date.now() - t) / 1000).toFixed(1)} s`);
  };
  try {
    await step("reset schemas", `
      DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS app CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`);
    await sql.unsafe(readFileSync(path.join(import.meta.dirname, "../test/db/supabase-stub.sql"), "utf8"));
    await migrate(drizzle(sql), { migrationsFolder: path.join(import.meta.dirname, "../drizzle") });
    console.log("migrations applied");

    // Users (profiles via the auth trigger, so triggers stay on for this part).
    await step("users", `
      INSERT INTO auth.users (email, raw_user_meta_data) VALUES
        ('perf-owner@test.local', '{"full_name":"Perf Owner"}'),
        ('perf-finance@test.local', '{"full_name":"Perf Finance"}'),
        ('perf-sales1@test.local', '{"full_name":"Sales One"}'),
        ('perf-sales2@test.local', '{"full_name":"Sales Two"}'),
        ('perf-sales3@test.local', '{"full_name":"Sales Three"}');
      INSERT INTO auth.users (email, raw_user_meta_data)
        SELECT 'perf-collector' || g || '@test.local', jsonb_build_object('full_name', 'Collector ' || g) FROM generate_series(1, 5) g;
      INSERT INTO public.user_roles (user_id, role) SELECT id, 'owner_admin' FROM auth.users WHERE email = 'perf-owner@test.local';
      INSERT INTO public.user_roles (user_id, role) SELECT id, 'finance' FROM auth.users WHERE email = 'perf-finance@test.local';
      INSERT INTO public.user_roles (user_id, role) SELECT id, 'sales' FROM auth.users WHERE email LIKE 'perf-sales%';
      INSERT INTO public.user_roles (user_id, role) SELECT id, 'operations' FROM auth.users WHERE email LIKE 'perf-collector%';`);

    await sql.unsafe(`SET session_replication_role = replica; SELECT setseed(0.42);`);

    await step("vehicles, drivers, assignments, plans", `
      CREATE TEMP TABLE d AS
        SELECT g AS n, gen_random_uuid() AS driver_id, gen_random_uuid() AS vehicle_id,
          gen_random_uuid() AS boundary_acc, gen_random_uuid() AS charges_acc, gen_random_uuid() AS plan_id,
          ('${START}'::date + ((g * 7919) % 300))::date AS start_date,
          (60000 + ((g * 37) % 7) * 5000)::bigint AS rate,
          (g <= 200) AS rto,
          (SELECT array_agg(id ORDER BY email) FROM auth.users WHERE email LIKE 'perf-collector%') AS collectors
        FROM generate_series(1, ${DRIVERS}) g;
      INSERT INTO public.vehicles (id, plate_no, make, model, year, powertrain, status, funding_source, acquired_on, acquisition_cost_centavos,
        orcr_expires_on, insurance_expires_on)
        SELECT vehicle_id, 'PRF ' || lpad(n::text, 4, '0'), CASE WHEN n % 5 = 0 THEN 'BYD' ELSE 'Toyota' END,
          CASE WHEN n % 5 = 0 THEN 'e6' ELSE 'Vios' END, 2024,
          (CASE WHEN n % 5 = 0 THEN 'ev' WHEN n % 20 = 1 THEN 'hybrid' ELSE 'ice' END)::public.powertrain,
          'assigned', CASE WHEN n % 5 = 1 THEN 'investor' WHEN n % 5 = 2 THEN 'financed' ELSE 'company' END::public.funding_source,
          start_date - 30, 90000000, '${END}'::date + (n % 400) - 30, '${END}'::date + (n % 300) - 20
        FROM d;
      INSERT INTO public.vehicles (plate_no, make, model, year, powertrain, status)
        SELECT 'SPR ' || lpad(g::text, 4, '0'), 'Toyota', 'Vios', 2023, 'ice', CASE WHEN g <= 12 THEN 'maintenance' ELSE 'available' END::public.vehicle_status
        FROM generate_series(1, 20) g;
      INSERT INTO public.drivers (id, first_name, last_name, phone, status, license_expiry)
        SELECT driver_id, 'Driver' || n, 'Perf' || lpad(n::text, 4, '0'), '0917' || lpad(n::text, 7, '0'), 'active', '${END}'::date + (n % 700) - 10 FROM d;
      INSERT INTO public.vehicle_assignments (vehicle_id, driver_id, start_date) SELECT vehicle_id, driver_id, start_date FROM d;
      INSERT INTO public.driver_accounts (id, driver_id, kind, opened_on)
        SELECT boundary_acc, driver_id, 'boundary'::public.account_kind, start_date FROM d
        UNION ALL SELECT charges_acc, driver_id, 'charges'::public.account_kind, start_date FROM d;
      INSERT INTO public.boundary_plans (id, driver_id, account_id, program_type, daily_rate_centavos, effective_from)
        SELECT plan_id, driver_id, boundary_acc, CASE WHEN rto THEN 'rto' ELSE 'boundary' END::public.program_type, rate, start_date FROM d;`);

    await step("boundary charges (daily)", `
      INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date, vehicle_id, plan_id, idempotency_key, memo, posted_at)
        SELECT d.boundary_acc, d.driver_id, 'boundary_charge', d.rate, day::date, day::date, d.vehicle_id, d.plan_id,
          'boundary:' || d.plan_id || ':' || day::date, 'Daily boundary', day + interval '16 hours 5 minutes'
        FROM d, generate_series(d.start_date, '${END}'::date, interval '1 day') day
        WHERE NOT EXISTS (SELECT 1 FROM public.holidays h WHERE h.date = day::date);`);

    // Payments: most days paid in full; some days skipped, some paid double (catch-up), some partial.
    await step("boundary payments", `
      CREATE TEMP TABLE pay AS
        SELECT gen_random_uuid() AS id, gen_random_uuid() AS entry_id, d.driver_id, d.boundary_acc, day::date AS day,
          CASE WHEN r < 50 THEN 0 WHEN r < 100 THEN d.rate * 2 WHEN r < 130 THEN d.rate / 2 ELSE d.rate END::bigint AS amount,
          CASE WHEN m < 700 THEN 'cash' WHEN m < 900 THEN 'gcash' WHEN m < 950 THEN 'maya' ELSE 'bank_transfer' END AS method,
          d.collectors[1 + (d.n % 5)] AS collector
        FROM d, generate_series(d.start_date, '${END}'::date, interval '1 day') day,
          LATERAL (SELECT (hashtext(d.n::text || ':' || day::text) & 2147483647) % 1000 AS r,
            (hashtext(day::text || '#' || d.n::text) & 2147483647) % 1000 AS m) x
        WHERE day::date < '${END}'::date OR d.n % 3 = 0;
      DELETE FROM pay WHERE amount = 0;
      INSERT INTO public.payments (id, driver_id, amount_centavos, method, reference_no, received_at, business_date, collector_id, client_request_id, created_at)
        SELECT id, driver_id, amount, method::public.payment_method, CASE WHEN method = 'cash' THEN NULL ELSE 'REF' || left(id::text, 8) END,
          day + interval '2 hours', day, collector, gen_random_uuid(), day + interval '2 hours' FROM pay;
      INSERT INTO public.ledger_entries (id, account_id, driver_id, entry_type, amount_centavos, business_date, payment_id, memo, posted_at)
        SELECT entry_id, boundary_acc, driver_id, 'payment', -amount, day, id, 'Payment', day + interval '2 hours' FROM pay;
      INSERT INTO public.payment_lines (payment_id, account_id, amount_centavos, ledger_entry_id)
        SELECT id, boundary_acc, amount, entry_id FROM pay;`);

    await step("remittances (cash, per collector per day)", `
      CREATE TEMP TABLE rem AS
        SELECT gen_random_uuid() AS id, collector, day, SUM(amount)::bigint AS total
        FROM pay WHERE method = 'cash' AND day < '${END}'::date GROUP BY collector, day;
      INSERT INTO public.remittances (id, collector_id, business_date, expected_centavos, remitted_centavos, received_by, received_at)
        SELECT id, collector, day, total, total - CASE WHEN random() < 0.02 THEN 5000 ELSE 0 END,
          (SELECT id FROM auth.users WHERE email = 'perf-finance@test.local'), day + interval '20 hours' FROM rem;
      INSERT INTO public.remittance_payments (remittance_id, payment_id)
        SELECT r.id, p.id FROM pay p JOIN rem r ON r.collector = p.collector AND r.day = p.day WHERE p.method = 'cash';`);

    await step("RTO contracts + monthly amortization", `
      CREATE TEMP TABLE c AS
        SELECT n, driver_id, vehicle_id, gen_random_uuid() AS id, gen_random_uuid() AS acc, start_date,
          (80000000 + (n % 5) * 10000000)::bigint AS price, 5000000::bigint AS down, (start_date + 30) AS first_due
        FROM d WHERE rto;
      INSERT INTO public.driver_accounts (id, driver_id, kind, contract_id, opened_on) SELECT acc, driver_id, 'amortization', id, start_date FROM c;
      INSERT INTO public.rto_contracts (id, driver_id, vehicle_id, account_id, contract_price_centavos, down_payment_centavos, term_months, start_date, first_due_date)
        SELECT id, driver_id, vehicle_id, acc, price, down, 60, start_date, first_due FROM c;
      CREATE TEMP TABLE inst AS
        SELECT c.*, 0 AS seq, c.start_date AS due, c.down AS amount FROM c
        UNION ALL
        SELECT c.*, s, (c.first_due + ((s - 1) || ' months')::interval)::date, (c.price - c.down) / 60 FROM c, generate_series(1, 60) s
        WHERE (c.first_due + ((s - 1) || ' months')::interval)::date <= '${END}'::date;
      INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date, vehicle_id, idempotency_key, memo, posted_at)
        SELECT acc, driver_id, 'amortization_charge', amount, due, due, vehicle_id, 'amort:' || id || ':' || seq, 'Amortization', due + interval '16 hours'
        FROM inst;
      CREATE TEMP TABLE apay AS
        SELECT gen_random_uuid() AS pid, gen_random_uuid() AS eid, i.driver_id, i.acc, i.due + (i.n % 4) AS day, i.amount,
          (SELECT collectors[1] FROM d LIMIT 1) AS collector
        FROM inst i WHERE (i.n + i.seq) % 12 <> 0 AND i.due + (i.n % 4) <= '${END}'::date;
      INSERT INTO public.payments (id, driver_id, amount_centavos, method, reference_no, received_at, business_date, collector_id, client_request_id, created_at)
        SELECT pid, driver_id, amount, 'bank_transfer', 'BDO' || left(pid::text, 8), day + interval '3 hours', day, collector, gen_random_uuid(), day + interval '3 hours' FROM apay;
      INSERT INTO public.ledger_entries (id, account_id, driver_id, entry_type, amount_centavos, business_date, payment_id, memo, posted_at)
        SELECT eid, acc, driver_id, 'payment', -amount, day, pid, 'Payment', day + interval '3 hours' FROM apay;
      INSERT INTO public.payment_lines (payment_id, account_id, amount_centavos, ledger_entry_id) SELECT pid, acc, amount, eid FROM apay;`);

    await step("driver costs, a few voids", `
      INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, due_date, memo, posted_at)
        SELECT charges_acc, driver_id, 'deposit_charge', 1000000, start_date, start_date, 'Deposit', start_date + interval '9 hours' FROM d WHERE n % 5 = 0;
      INSERT INTO public.payment_voids (payment_id, reason, voided_by)
        SELECT id, 'perf seed: wrong driver', (SELECT id FROM auth.users WHERE email = 'perf-finance@test.local')
        FROM pay WHERE method <> 'cash' ORDER BY pay.id LIMIT 300;
      INSERT INTO public.ledger_entries (account_id, driver_id, entry_type, amount_centavos, business_date, reverses_entry_id, memo, reason)
        SELECT p.boundary_acc, p.driver_id, 'reversal', p.amount, p.day + 1, p.entry_id, 'Void', 'perf seed'
        FROM pay p JOIN public.payment_voids v ON v.payment_id = p.id;`);

    await step("loans, investors, payouts", `
      CREATE TEMP TABLE l AS SELECT n, vehicle_id, gen_random_uuid() AS id, start_date FROM d WHERE n % 5 = 2;
      INSERT INTO public.vehicle_loans (id, vehicle_id, lender, principal_centavos, annual_rate_bps, term_months, first_due_date)
        SELECT id, vehicle_id, 'BDO Auto Loans', 60000000, 1200, 48, start_date + 30 FROM l;
      INSERT INTO public.loan_schedule_lines (loan_id, seq, due_date, opening_balance_centavos, principal_centavos, interest_centavos, payment_centavos, closing_balance_centavos)
        SELECT id, s, (start_date + 30 + ((s - 1) || ' months')::interval)::date, 60000000 - (s - 1) * 1250000, 1250000, 0, 1250000, 60000000 - s * 1250000
        FROM l, generate_series(1, 48) s;
      INSERT INTO public.loan_payments (loan_id, paid_on, amount_centavos, reference)
        SELECT loan_id, due_date, payment_centavos, 'auto-debit' FROM public.loan_schedule_lines WHERE due_date <= '${END}'::date - 3;
      INSERT INTO public.investors (id, name) SELECT gen_random_uuid(), 'Investor ' || g FROM generate_series(1, 20) g;
      UPDATE public.vehicles v SET investor_id = (SELECT id FROM public.investors ORDER BY name OFFSET (d.n % 20) LIMIT 1)
        FROM d WHERE d.vehicle_id = v.id AND d.n % 5 = 1;
      INSERT INTO public.investor_payouts (month, vehicle_id, investor_id, driver_id, daily_rate_centavos, monthly_amortization_centavos, boundary_days,
        computed_centavos, payable_centavos, status, paid_on, reference)
        SELECT m::date, d.vehicle_id, v.investor_id, d.driver_id, d.rate, 0, 22, d.rate * 22, d.rate * 22,
          CASE WHEN m::date < date_trunc('month', '${END}'::date) THEN 'paid' ELSE 'draft' END::public.investor_payout_status,
          CASE WHEN m::date < date_trunc('month', '${END}'::date) THEN (m + interval '1 month 4 days')::date END, 'INV'
        FROM d JOIN public.vehicles v ON v.id = d.vehicle_id,
          generate_series(date_trunc('month', d.start_date), date_trunc('month', '${END}'::date), interval '1 month') m
        WHERE d.n % 5 = 1;`);

    await step("office: expenses, payroll, advances, commissions", `
      INSERT INTO public.expenses (category_id, vendor, description, amount_centavos, expense_date, paid_via, created_at)
        SELECT (SELECT id FROM public.expense_categories ORDER BY sort OFFSET (g % 9) LIMIT 1), 'Vendor ' || (g % 40),
          'Perf expense ' || g, 50000 + (g * 7919 % 2000000), '${START}'::date + (g % 1095),
          (ARRAY['cash', 'gcash', 'bank_transfer', 'check', 'maya'])[1 + g % 5], '${START}'::date + (g % 1095)
        FROM generate_series(1, 9000) g;
      INSERT INTO public.expenses (category_id, description, amount_centavos, expense_date, paid_via, reference)
        SELECT (SELECT id FROM public.expense_categories WHERE name = 'Salaries'), 'Payroll ' || m::date, 45000000,
          (m + interval '14 days')::date, 'payroll', 'payroll:perf'
        FROM generate_series('${START}'::date, '${END}'::date - 15, interval '15 days') m;
      INSERT INTO public.employees (id, employee_no, first_name, last_name, hire_date, basis, rate_centavos)
        VALUES (gen_random_uuid(), 'E-900', 'Perf', 'Staff', '${START}', 'monthly', 3000000);
      INSERT INTO public.cash_advances (id, employee_id, given_on, amount_centavos, purpose)
        SELECT gen_random_uuid(), (SELECT id FROM public.employees WHERE employee_no = 'E-900'), '${START}'::date + g * 5, 300000, 'Client meeting'
        FROM generate_series(1, 200) g;
      INSERT INTO public.cash_advance_settlements (cash_advance_id, kind, amount_centavos, settled_on)
        SELECT id, 'cash_return', 100000, given_on + 3 FROM public.cash_advances;
      INSERT INTO public.commissions_received (source_type, counterparty, description, amount_centavos, received_on)
        SELECT 'platform', 'inDrive', 'Activation incentive', 150000 + g * 100, '${START}'::date + g * 3 FROM generate_series(1, 360) g;
      INSERT INTO public.referral_commissions (rto_contract_id, referrer_type, referrer_name, base_centavos, rate_bps, amount_centavos, payable_on, status, paid_on)
        SELECT id, 'external', 'Referrer ' || n, down, 1000, down / 10, start_date + 30,
          CASE WHEN start_date + 60 < '${END}'::date THEN 'paid' ELSE 'pending' END::public.commission_status,
          CASE WHEN start_date + 60 < '${END}'::date THEN start_date + 60 END FROM c;`);

    await step("applications, fees, payments", `
      CREATE TEMP TABLE cl AS SELECT gen_random_uuid() AS id, g - 1 AS rn FROM generate_series(1, 3000) g;
      INSERT INTO public.clients (id, name, mobile) SELECT id, 'Client ' || rn, '0918' || lpad(rn::text, 7, '0') FROM cl;
      CREATE TEMP TABLE a AS
        SELECT gen_random_uuid() AS id, g,
          (SELECT cl.id FROM cl WHERE cl.rn = g % 3000) AS client_id,
          (ARRAY['ltfrb_pa_new', 'ltfrb_cpc_new', 'ltfrb_cpc_renewal', 'platform_activation', 'vehicle_acquisition', 'driver_program'])[1 + g % 6] AS type_key,
          (ARRAY['inquiry', 'requirements_pending', 'filed', 'approved', 'completed', 'completed', 'cancelled', 'on_hold'])[1 + g % 8] AS status_key,
          ('${START}'::date + (g * 7 % 1095))::timestamptz + interval '10 hours' AS created
        FROM generate_series(1, 4000) g;
      INSERT INTO public.applications (id, type_key, client_id, status_key, created_at, status_changed_at, approved_at, completed_at, cancel_reason, assigned_to)
        SELECT id, type_key, client_id, status_key, created, created + interval '20 days',
          CASE WHEN status_key IN ('approved', 'completed') THEN created + interval '15 days' END,
          CASE WHEN status_key = 'completed' THEN created + interval '20 days' END,
          CASE WHEN status_key = 'cancelled' THEN 'perf' END,
          (SELECT id FROM auth.users WHERE email = 'perf-sales' || (1 + g % 3) || '@test.local')
        FROM a;
      INSERT INTO public.application_fees (application_id, description, amount_centavos, created_at) SELECT id, 'Service fee', 1500000, created FROM a;
      INSERT INTO public.application_payments (application_id, amount_centavos, method, reference_no, received_on, received_by, client_request_id, created_at)
        SELECT id, 1500000, CASE WHEN g % 3 = 0 THEN 'gcash' ELSE 'cash' END::public.payment_method, CASE WHEN g % 3 = 0 THEN 'G' || g END,
          (created + interval '2 days')::date, (SELECT id FROM auth.users WHERE email = 'perf-finance@test.local'), gen_random_uuid(), created + interval '2 days'
        FROM a WHERE status_key <> 'inquiry' AND created + interval '2 days' <= '${END}'::date;`);

    await step("leads", `
      INSERT INTO public.leads (name, mobile, source, interest, stage_key, assigned_to, created_at, updated_at, converted_at, lost_reason)
        SELECT 'Lead ' || g, '0919' || lpad(g::text, 7, '0'),
          (ARRAY['facebook_page', 'messenger', 'fb_lead_ad', 'landing_page', 'referral', 'walk_in'])[1 + g % 6]::public.lead_source,
          (ARRAY['franchise', 'activation', 'vehicle_program'])[1 + g % 3]::public.service_line,
          (ARRAY['new', 'contacted', 'qualified', 'converted', 'lost', 'converted', 'lost', 'requirements_sent'])[1 + g % 8],
          (SELECT id FROM auth.users WHERE email = 'perf-sales' || (1 + g % 3) || '@test.local'),
          ('${START}'::date + (g * 13 % 1095))::timestamptz, ('${START}'::date + (g * 13 % 1095))::timestamptz + interval '5 days',
          CASE WHEN g % 8 IN (3, 5) THEN ('${START}'::date + (g * 13 % 1095))::timestamptz + interval '5 days' END,
          CASE WHEN g % 8 IN (4, 6) THEN 'perf' END
        FROM generate_series(1, 12000) g;`);

    await sql.unsafe(`SET session_replication_role = origin;`);
    await step("vacuum analyze", `VACUUM (ANALYZE);`);
    const [counts] = await sql`
      SELECT (SELECT count(*) FROM public.ledger_entries)::int AS ledger, (SELECT count(*) FROM public.payments)::int AS payments,
        (SELECT count(*) FROM public.drivers)::int AS drivers, (SELECT count(*) FROM public.expenses)::int AS expenses,
        (SELECT count(*) FROM public.leads)::int AS leads, (SELECT count(*) FROM public.applications)::int AS applications`;
    console.log({ from: START, to: END, ...counts, seconds: Math.round((Date.now() - t0) / 1000) });
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

-- Default settings. Values are validated by src/lib/settings/registry.ts;
-- a test asserts every seeded key parses. Existing values are never overwritten.
SELECT set_config('app.actor_label', 'migration:0002_seed_settings', true);
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('company.profile',
   '{"name":"TransRev","address":"","phone":"","email":""}',
   'Company details printed on statements, payslips and receipts.'),
  ('business.timezone',
   '"Asia/Manila"',
   'Timezone for business dates. A boundary day is a calendar date in this zone.'),
  ('ledger.allocation_strategy',
   '"oldest_due_first"',
   'How payments are applied to open charges within an account.'),
  ('collections.penalties_enabled',
   'false',
   'Late penalties. Confirmed OFF by the owner (2026-09-27).'),
  ('collections.delinquency_flag_months',
   '3',
   'Flag a driver when their oldest unpaid due is at least this many months old.'),
  ('payroll.frequency',
   '"semi_monthly"',
   'Payroll period frequency.'),
  ('payroll.thirteenth_month_enabled',
   'true',
   'Compute 13th month pay (1/12 of basic salary earned in the calendar year).'),
  ('sms.sender_name',
   'null',
   'Registered SMS sender name (e.g. with Semaphore). Null until registered.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Government tables. VERIFY WITH ACCOUNTANT before the first live payroll run.
-- Amounts in centavos, rates in basis points (1% = 100 bps).
INSERT INTO public.gov_contribution_tables (agency, effective_from, config, notes) VALUES
  ('sss', '2025-01-01',
   '{"employee_rate_bps":500,"employer_rate_bps":1000,"msc_min_centavos":500000,"msc_max_centavos":3500000,"msc_step_centavos":50000,"ec_threshold_msc_centavos":1500000,"ec_low_centavos":1000,"ec_high_centavos":3000}',
   'SSS 2025 schedule: 15% total (EE 5%, ER 10%), MSC 5,000–35,000 in 500 steps, EC 10 below MSC 15,000 else 30. TODO verify.'),
  ('philhealth', '2024-01-01',
   '{"rate_bps":500,"floor_centavos":1000000,"ceiling_centavos":10000000,"employee_share_bps":5000}',
   'PhilHealth 5% of basic monthly salary, floor 10,000, ceiling 100,000, shared 50/50. TODO verify.'),
  ('pagibig', '2024-02-01',
   '{"employee_rate_bps":200,"employee_rate_low_bps":100,"low_threshold_centavos":150000,"employer_rate_bps":200,"max_fund_salary_centavos":1000000}',
   'Pag-IBIG 2%/2% on max fund salary 10,000 (EE 1% if salary <= 1,500). TODO verify.'),
  ('bir_wtax', '2023-01-01',
   '{"basis":"annual","brackets":[{"over_centavos":0,"base_tax_centavos":0,"rate_bps":0},{"over_centavos":25000000,"base_tax_centavos":0,"rate_bps":1500},{"over_centavos":40000000,"base_tax_centavos":2250000,"rate_bps":2000},{"over_centavos":80000000,"base_tax_centavos":10250000,"rate_bps":2500},{"over_centavos":200000000,"base_tax_centavos":40250000,"rate_bps":3000},{"over_centavos":800000000,"base_tax_centavos":220250000,"rate_bps":3500}]}',
   'TRAIN law annual income tax table effective 2023. Payroll annualises/periodises. TODO verify.')
ON CONFLICT (agency, effective_from) DO NOTHING;

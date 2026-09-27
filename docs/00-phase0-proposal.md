# TransRev Operations System: Phase 0 Proposal

Status: **partly confirmed**. The owner's answers of 2026-09-27 are recorded in §6. Phase 1 (foundation) is built. Phase 2 (the money engine) waits on the follow-ups in §7.

---

## 1. Understanding of the system

TransRev runs three lines of business for the Philippine TNVS market:

1. **LTFRB franchise documentation.** Handling PA and CPC applications for operators, and renewing them before they expire.
2. **Platform activation.** Onboarding drivers and vehicles onto ride-hailing platforms, mainly inDrive.
3. **Vehicle programs.** A fleet, including regional EVs, that drivers operate under one of three arrangements:
   - **Boundary.** The driver pays a daily rental and never owns the car.
   - **Boundary-hulog.** Part of each boundary pays down the vehicle.
   - **Rent-to-Own (RTO).** A contract with a total price, a down payment and a term. It ends in ownership transfer, or earlier through a cashout (early buyout).

   Some vehicles are funded by investors who receive a revenue share. Some are financed through banks or dealers, with monthly amortization.

All of this runs on spreadsheets today. The biggest bottleneck is posting every driver's boundary by hand each day, and because the figures are unreliable, staff end up guessing collections.

The system will do the following:
- It will **post each day's charges automatically** to an append-only ledger.
- Collectors will **record payments on mobile**, and the system will allocate each payment to dues.
- Drivers and management will see **balances computed from the ledger**, with no hand-typed balances.
- It will run office finance: expenses, payroll, commissions and investor payouts.
- It will run the front of the funnel: the CRM, applications and the school landing page.
- It will send **automatic SMS reminders**.
- It will produce **reports and exports**.

Permissions are enforced in Postgres through RLS. A driver can only see their own data.

---

## 2. Stack notes (items I recommend adjusting)

| Topic | Recommendation |
|---|---|
| **Drizzle + RLS** | Drizzle normally connects as a privileged role, and that role **bypasses RLS**. I propose a `withUserTx(user, fn)` helper that runs each request in a transaction: `SET LOCAL ROLE authenticated` plus `set_config('request.jwt.claims', …)`. That way RLS applies to every server-side query. The service role is used only by cron jobs and webhooks, and only through a separate, clearly named client. |
| **Money logic location** | Allocation, charge generation and cashout math will be **pure TypeScript functions**, fully unit-tested in Vitest. They are persisted inside a DB transaction that holds a per-driver `pg_advisory_xact_lock`, so two collectors posting at once cannot double-allocate. |
| **Daily charge job** | Vercel Cron will call an authenticated route. The job is **idempotent**: each charge has a unique key `(plan_id, business_date)`. It **catches up** on any days it missed, for example after an outage, and every run is logged in `charge_runs`. |
| **Driver OTP login** | Supabase phone auth does not support Semaphore natively. I would use Supabase's **Send SMS Auth Hook** to route OTPs through our SMS provider interface. |
| **Semaphore sender name** | Sender names must be registered with Semaphore, and approval takes time. Worth starting early. |
| **Meta Lead Ads** | The webhook needs a Meta app, a page token and app review. If Messenger is the only channel today, the first version ships with manual entry plus a quick-add form. |

---

## 3. Ledger design (core of the system)

### 3.1 Principles
- All amounts are `bigint` centavos. The sign convention is **positive = driver owes more (debit)** and **negative = driver owes less (credit)**.
- `ledger_entries` is **append-only**. A trigger rejects `UPDATE` and `DELETE`, and the table grants no update or delete privileges.
- A correction is a **reversal entry**. It sets `reverses_entry_id` to the original entry, copies the original amount with the opposite sign, and records `reason` and `created_by`. The original can be reversed only once, enforced by a unique index.
- **Balance = `SUM(amount_centavos)`** for an account. An optional `account_balances` materialized view or cache table can hold this value, but it is rebuilt from the ledger and is never written directly.
- Every entry carries a `business_date` (a Manila calendar date) and `posted_at` (a `timestamptz`).

### 3.2 Tables

**`driver_accounts`**: one receivable account per driver per program engagement.
- Columns: `id`, `driver_id`, `program_type` (boundary | boundary_hulog | rto), `boundary_plan_id?`, `rto_contract_id?`, `opened_on`, `closed_on?`, `status`.
- Why this layer exists: a driver who moves from boundary to RTO keeps each history separate and correct.

**`ledger_entries`**
| column | notes |
|---|---|
| `id` uuid | |
| `account_id` → driver_accounts | |
| `driver_id` | denormalised for RLS and speed |
| `entry_type` enum | `opening_balance`, `boundary_charge`, `penalty`, `fee`, `payment`, `bonus_credit`, `cashout_discount`, `adjustment`, `reversal`, `write_off` |
| `amount_centavos` bigint | signed, non-zero |
| `principal_centavos` bigint | the part of a charge that reduces the vehicle principal (hulog/RTO); 0 otherwise |
| `business_date` date | Manila |
| `due_date` date | for charges; drives aging and FIFO |
| `source_type`, `source_id` | e.g. `payment`/uuid, `charge_run`/uuid, `quota_result`/uuid |
| `reverses_entry_id` | unique, nullable |
| `idempotency_key` text unique | e.g. `charge:{plan}:{2026-09-27}` |
| `memo`, `reason` | reason required for adjustment/reversal/write-off |
| `created_by`, `posted_at` | |

**`payments`**: one row per receipt, i.e. money actually received.
- Columns: `driver_id`, `account_id`, `amount_centavos`, `method` (cash | gcash | maya | bank_transfer | other), `reference_no`, `received_at`, `business_date`, `collector_id`, `receipt_path`, `remittance_id?`, `status` (posted | reversed), `client_request_id` (unique, so a double-tap on mobile cannot create two payments).
- Each payment creates exactly one `payment` ledger credit.

**`payment_allocations`**: links a payment to the charge entries it settles.
- Columns: `payment_id`, `charge_entry_id`, `amount_centavos`, `principal_centavos`, `allocated_at`, `reverses_allocation_id?`.
- An open (unpaid) charge = charge amount − its allocations.
- Any unallocated part of a payment is an **advance credit**. It is allocated automatically when later charges post.
- The allocation strategy is a setting. The default is `oldest_due_first`: order by due_date, then penalties before boundary or the reverse (to confirm).

**Derived views**, all computed and never stored:
- `v_account_balance`: the current balance of each account.
- `v_charge_status`: each charge's amount, paid amount, outstanding amount and status (paid | short | unpaid).
- `v_boundary_calendar`: each driver's status per date, which feeds the compliance calendar.
- `v_receivable_aging`: open charges in 1–7, 8–30 and 31+ day buckets.
- `v_principal_paid`: the sum of `principal_centavos` over allocations, used for RTO/hulog progress.

### 3.3 Boundary plans
- **`boundary_plans`** columns: `driver_id`, `vehicle_id`, `program_type`, `effective_from`, `effective_to?`, `status`, `default_rate_centavos`, `default_principal_centavos`, `grace_days`, `penalty_rule_id?`.
  Plans are **versioned**. A rate change closes the current row and opens a new one, so past charges always match the plan that produced them.
- **`boundary_plan_day_rates`** columns: `plan_id`, `weekday` (0–6), `rate_centavos`, `principal_centavos`, `chargeable` bool.
  This handles different weekday and weekend rates and weekly rest days.
- **`charge_exceptions`** columns: `plan_id` or `vehicle_id`, `date_from`, `date_to`, `kind` (waived | reduced), `amount_override?`, `reason`, `approved_by`.
  Covers repairs, holidays, typhoons and number coding (to confirm).
- **`charge_runs`** columns: `business_date`, `started_at`, `finished_at`, `plans_seen`, `charges_posted`, `skipped`, `errors` jsonb.

### 3.4 Penalties
- **`penalty_rules`** columns: `name`, `kind` (flat | percent_of_shortage), `amount`, `grace_days`, `cap`, `active`.
- A nightly step posts `penalty` entries, idempotent per charge. Penalties are **off by default** until confirmed.

### 3.5 Collector remittance
- **`remittances`** columns: `collector_id`, `business_date`, `expected_cash_centavos` (snapshotted from the linked cash payments), `remitted_centavos`, `received_by`, `received_at`, `notes`.
- Variance is computed, not stored.
- Payments get their `remittance_id` when they are remitted. Unremitted cash per collector is always visible.

---

## 4. Full schema by module

Every table has `id uuid`, `created_at` and `created_by`, plus `updated_at` and `updated_by` where rows are mutable. Financial tables are insert-only.

### Foundation
- **`profiles`**: `user_id` → auth.users, `full_name`, `phone`, `status`.
- **`user_roles`**: `user_id`, `role` enum (owner_admin | finance | operations | sales | driver | investor). One user can hold several roles.
  RLS helpers: `auth_has_role(role)`, `auth_driver_id()`, `auth_investor_id()`.
- **`audit_log`**: `table_name`, `row_id`, `action`, `actor_id`, `at`, `before` jsonb, `after` jsonb, `ip?`. It is filled by one generic trigger attached to every audited table.
- **`app_settings`**: `key`, `value` jsonb, `updated_by`. Holds scalar settings such as the allocation strategy, timezone and company info.
- **`documents`**: `owner_type`, `owner_id`, `doc_type`, `storage_path` (private bucket), `mime`, `size`, `uploaded_by`, `expires_on?`.
- **`document_access_log`**: `document_id`, `actor_id`, `at`, `purpose`. A row is written every time a signed URL is issued.

### Drivers & vehicles
- **`drivers`**: `profile_id?` (set when the driver has a login), `first/last name`, `phone`, `email`, `address`, `birthdate`, `license_no`, `license_expiry`, `emergency_contact_*`, `status` (applicant | active | suspended | completed | terminated), `referred_by_*`, `lead_id?`.
- **`vehicles`**: `plate_no` unique, `make`, `model`, `year`, `color`, `is_ev`, `region`, `acquisition_cost_centavos`, `acquired_on`, `funding_source` (company | investor | financed), `status`, `ownership_transferred_to_driver_id?`.
- **`vehicle_platforms`**: `vehicle_id`, `platform` (indrive, …), `enrolled_on`, `status`.
- **`franchises`**: `vehicle_id?`, `operator_name`, `kind` (PA | CPC), `number`, `issued_on`, `expires_on`, `status`, `application_id?`.
- **`vehicle_assignments`**: `vehicle_id`, `driver_id`, `start_date`, `end_date?`, `reason`. A partial unique index allows only one open assignment per vehicle.

### RTO & amortization
- **`rto_contracts`**: `driver_id`, `vehicle_id`, `account_id`, `contract_price_centavos`, `down_payment_centavos`, `financed_principal_centavos`, `term_days|weeks|months`, `start_date`, `status` (active | cashed_out | completed | defaulted | terminated).
- **`cashout_rules`**: `name`, `discount_kind` (percent | flat | none), `discount_value`, `fee_kind`, `fee_value`, `min_months_paid?`, `active`.
- **`cashout_quotes`**: `contract_id`, `as_of_date`, `outstanding_centavos`, `remaining_principal_centavos`, `discount_centavos`, `fee_centavos`, `payoff_centavos`, `valid_until`, `pdf_path`, `status` (quoted | paid | expired).
  When the quote is paid, the system posts a payment plus a `cashout_discount` entry, closes the contract and records the ownership transfer.
- **`vehicle_loans`**: `vehicle_id`, `lender`, `principal_centavos`, `annual_rate_bps`, `term_months`, `start_date`, `method` (diminishing | add_on | flat).
- **`loan_schedule_lines`**: `loan_id`, `seq`, `due_date`, `principal_centavos`, `interest_centavos`, `total_centavos`. Generated once and regenerated only by an explicit restructure.
- **`loan_payments`**: `loan_id`, `schedule_line_id`, `paid_on`, `amount_centavos`, `reference`.

### Quotas & bonuses
- **`quota_rules`**: `name`, `metric` (trips | earnings | boundary_streak_days | days_online), `period` (weekly | monthly), `threshold`, `bonus_centavos`, `payout_mode` (ledger_credit | cash_payout), `active`, `effective_from`.
- **`quota_results`**: `driver_id`, `rule_id`, `period_start`, `period_end`, `value`, `source` (manual | csv_import | computed), `hit` bool, `import_id?`.
- **`bonus_payouts`**: `driver_id`, `quota_result_id`, `amount_centavos`, `mode`, `ledger_entry_id?`, `paid_on?`, `status`.

### Commissions & investors
- **`referrals`**: `referrer_type` (driver | employee | external), `referrer_name/id`, `referred_driver_id|application_id`, `rule_id`, `amount_centavos`, `status` (pending | approved | paid), `paid_on`, `reference`.
- **`commission_rules`**: holds referral commission rules.
- **`commissions_received`**: `source` (platform | dealer), `counterparty`, `period`, `amount_centavos`, `received_on`, `reference`.
- **`investors`**: `name`, `contact`, `profile_id?`.
- **`investor_vehicle_shares`**: `investor_id`, `vehicle_id`, `basis` (pct_gross_boundary | pct_net_income | fixed_amount), `value`, `period` (weekly | monthly), `effective_from/to`.
- **`investor_payout_runs`**, **`investor_payout_lines`**: `run_id`, `investor_id`, `vehicle_id`, `gross`, `deductions`, `share`, `paid_on`, `statement_pdf`.

### Office operations
- **`expense_categories`**, **`expenses`** (`category_id`, `vendor`, `amount_centavos`, `expense_date`, `paid_via`, `receipt_doc_id`, `recurring_template_id?`, `status`), **`recurring_expense_templates`** (`category`, `amount`, `frequency`, `due_day`, `next_due`), **`budgets`** (`category_id`, `month`, `amount_centavos`).
- **`employees`**: `profile_id?`, `name`, `position`, `hire_date`, `salary_basis` (monthly | daily), `rate_centavos`, `tin`, `sss_no`, `philhealth_no`, `pagibig_no`, `status`.
- **`gov_contribution_tables`**: `agency` (sss | philhealth | pagibig | bir_wtax), `effective_from`, `brackets` jsonb.
- **`payroll_periods`**: `start`, `end`, `pay_date`, `status` (draft | finalized | paid). A finalized period is locked, and corrections go into the next period as adjustments.
- **`payroll_lines`**: per employee per period: `basic`, `allowances`, `overtime`, `gross`, `sss_ee/er`, `philhealth_ee/er`, `pagibig_ee/er`, `wtax`, `cash_advance_deduction`, `other_deductions`, `net`, `payslip_pdf`.
- **`allowance_types`**, **`employee_allowances`**.
- **`cash_advances`** and **`cash_advance_deductions`**: a cash advance is also its own mini-ledger.

### Applications, CRM, school
- **`applications`**: `type` (franchise_pa | franchise_cpc | platform_activation | vehicle_program), `applicant_name/phone/email`, `lead_id?`, `driver_id?`, `status` (received | docs_incomplete | in_process | filed_ltfrb | approved_released | rejected), `assigned_to`, `submitted_at`.
- **`application_checklist_items`** (per type, admin-editable), **`application_documents`**, **`application_status_history`**, **`application_notes`**.
- **`leads`**: `name`, `phone`, `email`, `source` (facebook_lead_ad | messenger | application_form | school_landing | manual), `interest` (franchise | activation | vehicle_program | school), `stage` (new | contacted | qualified | converted | lost), `assigned_to`, `next_follow_up_at`, `converted_to_type/id`, `utm` jsonb.
- **`lead_activities`**: `lead_id`, `kind` (call | sms | note | stage_change | messenger), `body`, `at`, `by`.
- **`school_settings`** (name, hero, about, contact, map, branding), **`school_courses`** (title, slug, description, duration, schedule, requirements, fee_centavos?, sort, published), **`school_instructors`**, **`school_faqs`**.
- **`inquiry_rate_limits`**: rate-limiting keyed on hashed IP and phone.

### Reminders
- **`sms_templates`**: `key`, `language` (en | taglish), `body` with `{{name}}` `{{amount}}` `{{due_date}}` `{{balance}}` variables, `active`.
- **`reminder_rules`**: `trigger` (balance_weekly | missed_boundary | upcoming_due | rto_milestone | license_expiry | franchise_expiry | lead_follow_up), `schedule` (cron in Manila time), `offset_days`, `template_key`, `audience_filter` jsonb, `active`.
- **`messages`**: `channel` (sms | email), `to`, `driver_id?`, `template_key`, `body`, `provider`, `provider_message_id`, `status`, `cost_centavos`, `sent_at`, `error`, `rule_id`, `dedupe_key`.
- **`communication_opt_outs`**: `phone`, `channel`, `scope`, `opted_out_at`, `source`.

### Import
- **`import_jobs`**: `kind` (drivers | vehicles | opening_balances | payments | employees | recurring_expenses), `file_path`, `mapping` jsonb, `status` (uploaded | validated | committed | failed), `cutoff_date`, `stats`.
- **`import_rows`**: `job_id`, `row_no`, `raw` jsonb, `parsed` jsonb, `errors` jsonb, `result_id?`.

---

## 5. RLS summary

| Data | owner_admin | finance | operations | sales | driver | investor |
|---|---|---|---|---|---|---|
| drivers / vehicles | RW | R | RW | R (limited) | own row R | own vehicles R |
| ledger / payments | R + post | R + post + adjust | R + post payments | – | own R | – |
| payroll / employees | RW | RW | – | – | – | – |
| investor data | RW | RW | – | – | – | own R |
| leads / applications | RW | R | RW | RW | – | – |
| settings | RW | R (gov tables RW?) | R | R | – | – |
| audit_log | R | R | – | – | – | – |

Nobody gets `UPDATE` or `DELETE` on ledger tables, not even owner_admin. Corrections go through reversal RPCs.

---

## 6. Confirmed business rules (owner, 2026-09-27)

These answers **replace** the earlier design where they conflict. In particular, §3.3's idea of "part of each boundary goes to principal" is dropped.

| # | Question | Answer | Design impact |
|---|---|---|---|
| 1 | Daily boundary | **One flat daily rate** per driver | `boundary_plans.daily_rate_centavos`. No weekday/weekend rate table. |
| 2 | Waivers | **No waivers** (repairs, holidays, typhoons, coding) | No `charge_exceptions` table. Mistakes are fixed only by audited reversal entries. |
| 3 | Plan follows | **The driver** | Plans belong to the driver. Each charge also stamps the `vehicle_id` assigned on that date, for per-vehicle profitability. |
| 4 | Hulog / RTO | **A fixed monthly amortization, separate from the boundary.** Ownership transfers when the contract ends. | Two obligation streams: a daily **boundary** account, and a monthly **amortization** account that carries the principal. |
| 5 | Payment split | **Boundary and amortization are handled separately. Each must be paid in full on schedule.** | Payments target one account, not a shared pool. An amortization installment counts as unpaid until fully covered. |
| 6 | Allocation / penalties | Allocation "depends". **No penalties.** | `collections.penalties_enabled = false` (seeded). No penalty engine in Phase 2. What allocation depends on is a follow-up (§7). |
| 7 | Deposits & costs | **Yes, security deposits. All costs are borne by the driver.** | Add a `deposit` account (money held, not income) and a driver-cost charge type (maintenance, charging, insurance…). |
| 8 | Delinquency | **3 months, flagged** | `collections.delinquency_flag_months = 3` (seeded). Drivers past it are flagged on dashboards. |
| 9 | Quota | **200 rides in a month** | A `quota_rules` row: metric = trips, period = monthly, threshold = 200. |
| 10 | Cashout | **Remaining principal, with discounts/fees** | `cashout_rules` stays configurable. Values still needed. |
| 11 | Vehicle loans | **Diminishing balance** | `vehicle_loans.method = 'diminishing'` with a standard annuity schedule. |
| 12 | Payroll | **Semi-monthly. SSS, PhilHealth, Pag-IBIG and withholding tax. Travel expenses and cash advances for business meetings. 13th month included.** | `payroll.frequency = semi_monthly` and `payroll.thirteenth_month_enabled = true` (seeded). Cash advances and travel liquidation become their own sub-ledger. |
| 13 | Investor share | **22 days of boundary − monthly amortization = profit for the investor share** | `investor_vehicle_shares.basis = 'boundary_22d_less_amortization'`. Open points in §7. |

## 7. Follow-ups still needed (these affect money)

1. **Chargeable days.** A flat rate for *every* calendar day, including Sundays? Or are some days not charged? (Q13's "22 days" suggests about 22 working days a month.)
2. **Amortization amounts and terms.** For a hulog/RTO driver, what are typical amounts (for example ₱X/day plus ₱Y/month)? What is the term in months? On what day of the month is the amortization due? Is there a down payment? Is there any difference between "boundary-hulog" and "RTO", or are they the same program?
3. **Lump-sum payments.** When a driver hands over one amount that covers both streams, who decides the split: the collector at entry, or a fixed rule (for example boundary first)? What does "depends" depend on?
4. **Partial amortization.** If a driver pays ₱3,000 toward a ₱5,000 installment, do we accept and hold it (the installment stays unpaid until the rest arrives), or refuse partials?
5. **Deposit.** Amount? Refundable at the end? Can it be applied to unpaid dues on termination?
6. **Driver costs.** Which costs are added to the driver's balance (maintenance, EV charging, insurance, registration, platform fees…)? Are they charged at cost, or with a markup?
7. **Delinquency trigger.** Flag when the *oldest unpaid due* is at least 3 months old, or when *3 monthly amortizations* are missed? Does a flag suspend the driver automatically, or only alert staff?
8. **Quota bonus.** How much is the bonus for 200 rides a month? Is it paid in cash or credited against the balance? Where do ride counts come from (an inDrive export? Please send a sample)?
9. **Cashout.** Discount and fee values (percentage or flat)? Any minimum months paid before a cashout is allowed?
10. **Investor share.** Is "22 days boundary" fixed (22 × daily rate, regardless of what was collected) or the actual amount collected? Is "monthly amortization" the vehicle's bank loan amortization or the driver's amortization? Does the investor get 100% of the result, or a percentage? Paid monthly?
11. **Payroll details.** Are government deductions split across both cut-offs or taken on one? Are unliquidated cash advances deducted from salary?
12. **Still unanswered:** Q14–Q22 (referral commission rules, driver login vs SMS-only, SMS provider/sender, Facebook Lead Ads, school details, headcounts, import cutoff date and sample sheets, official receipts).

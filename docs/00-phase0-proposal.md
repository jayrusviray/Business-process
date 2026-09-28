# TransRev Operations System: Phase 0 Proposal

Status: Phases 1–6 are built. The owner's answers are in §6 (round 1), §8 (round 2), §10 (round 3), §11 (round 4) and §12 (round 5). Where this document conflicts with §8–§12, the later sections win.

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

## 8. Owner answers, round 2 (2026-09-27)

| # | Question | Answer | Design impact |
|---|---|---|---|
| 1 | Chargeable days | **Every day except holidays** | `holidays` table (admin-maintained). The daily job skips those dates. |
| 2 | Amortization terms | **Depends on the vehicle. 5-year contract. Boundary-hulog and RTO are the same program.** | `program_type` is `boundary` or `rto`. Contract amounts are set per contract in Phase 4, with a 60-month term. |
| 3 | Lump-sum split | **The collector decides** | The payment form takes one amount per account. Nothing moves between accounts automatically. |
| 4 | Partial amortization | **Accepted** | Held as credit on the amortization account. The installment stays unpaid until fully covered. |
| 5 | Deposit | **Non-refundable** | `deposit_charge` on the charges account. It is never refunded or auto-applied. |
| 6 | Driver costs | **At cost** | `cost_charge` with a description. No markup. |
| 7 | Delinquency | **3 missed amortizations** (flag only) | Setting `collections.delinquency_missed_amortizations = 3`. `countMissed()` counts past-due installments that aren't fully paid. |
| 8 | Quota bonus | **Cash or credit, either one. Ride counts can come from anywhere.** | Phase 3: payout mode chosen per bonus. Manual entry plus CSV import. |
| 9 | Cashout | **No discounts, fees or minimums** | Cashout = remaining principal (see open question A). |
| 10 | Investor share | "Yes, paid monthly" | Monthly. The other sub-questions are still open (see B). |
| 11 | Payroll | **Deductions split across both cut-offs. Unliquidated cash advances are deducted from salary.** | Phase 6. |
| 14 | Referral commissions | **A percentage, paid after the driver's first N days** | Phase 6 rule: percentage + N days. The base and N are still needed. |
| 15 | Driver login | **Yes** | Phase 3 portal. |
| 16 | SMS | **Smart and Globe; no Semaphore account** | Provider interface in Phase 5. An aggregator is still needed (see C). |
| 17 | Leads | **Facebook and Messenger** | Phase 7: Lead Ads webhook plus manual Messenger entry. |
| 18 | Direct payments | **GCash/Maya and bank (BDO), recorded manually by staff** | Payment methods include bank transfer with a bank name. A reference number is required for non-cash payments. |
| 19 | School details | Not available | Placeholder content marked TODO. |
| 20 | Receipts | **Acknowledgement receipts only** | Numbered `AR-000001` receipts, labelled "not an official receipt". |

### Still open
- **A. Cashout principal.** Does the fixed monthly amortization include interest, or is it purely the vehicle price ÷ 60? If it includes interest, "remaining principal" is less than the sum of the remaining installments.
- **B. Investor share.** Is it 22 × daily rate (fixed) or actual collections? Is the amortization subtracted the bank loan's or the driver's? Does the investor get 100% or a percentage?
- **C. SMS provider.** Smart and Globe don't sell bulk SMS directly to small businesses. We need an aggregator account (for example Semaphore, M360 or Globe Labs). Phase 3's phone OTP login also depends on it. Until then, drivers could log in by email.
- **D. Referrals.** What is the percentage of (the boundary? the first payment?), and what is N?
- **E. Holidays.** Which ones apply: regular holidays only, or special non-working days too?

## 9. Implementation decisions made in Phase 2

- **Allocations are computed, not stored.** Oldest-due-first is a pure function of the ledger (`src/lib/ledger/allocation.ts`), mirrored by the SQL view `v_charge_status`, and a test checks they agree. This keeps statuses correct after reversals, voids and back-dated entries. The `payment_allocations` table from §3.2 is dropped.
- **Three accounts per driver:** `boundary`, `amortization` (Phase 4) and `charges` (costs and deposit).
- **Charges apply only to drivers with status `active` on that day.** Suspending a driver stops charges without ending the plan.
- **Plans cannot start in the past.** History before go-live comes in as opening balances (import in Phase 9), never as back-dated daily charges.
- **A void is a separate record** (`payment_voids`) that triggers reversal entries. Payment rows are never changed.
- **Remittances** cover cash only. If a payment is voided after it was remitted, the remittance shows the voided amount and an adjusted variance.

## 10. Owner answers, round 3 (2026-09-27)

| Question | Answer | Status |
|---|---|---|
| A. Does the amortization include interest? | "Yes" | **Needs clarification** (the question was either/or; see below) |
| B. Investor share details | "Yes" | **Needs clarification** (three sub-questions; see below) |
| C. SMS provider | Skip for now; send manually | Phase 5 generates the message text for staff to send from their own phone. Driver login uses **mobile number + password**, so no SMS is needed. |
| D. Referral commission | **A percentage of the down payment, paid after a month** | Phase 6 rule: percentage of down payment, payable 1 month after activation. The percentage is still needed. |
| E. Holidays | **Regular holidays only** | Seeded: the fixed-date regular holidays, Holy Week and National Heroes Day, through 2027. Eid'l Fitr and Eid'l Adha are added by an admin once proclaimed. |

### Phase 3 decisions
- **Driver portal login:** mobile number + password. Staff click "Give portal access" and hand the temporary password over in person. Operations and finance may grant only the `driver` role, and only to a login linked to a driver record.
- **Quota bonuses:** paid in cash or credited to the boundary balance, chosen per award by finance. A result is locked once a bonus is awarded. Voiding a credit reverses the ledger entry.
- **Seeded quota rule:** "200 rides per month", inactive until an admin sets the bonus amount.
- **Statement of account:** PDF (for drivers and staff) with the balance brought forward. Amounts show as "PHP" because the PDF's built-in fonts have no ₱ sign.

## 11. Owner answers, round 4 (2026-09-27)

| Question | Answer | Design impact |
|---|---|---|
| RTO interest | **(b) No interest.** The amortization is the vehicle price ÷ 60. | Installment = (price − down payment) ÷ term. The last installment absorbs the centavo remainder. Cashout = contract price − net amount paid. |
| Investor share | **22 × the daily boundary rate − the monthly amortization. No percentage split.** | Phase 6. Still to confirm which amortization is subtracted for investor vehicles: the bank loan's or the driver's RTO amortization. |
| Referral commission | **10% of the down payment, paid after a month** | Phase 6 rule. Default 10%, payable one month after the contract start. |

### Phase 4 decisions
- **Installments are computed, not stored.** Each posts to the driver's Amortization account on its due date (idempotency key `amort:{contract}:{seq}`). Installments are **not** skipped on holidays or for suspended drivers.
- **Contracts signed before go-live:** all installments due so far post at set-up. The amount already paid is entered as an opening credit.
- **Cashout:** the payoff is recorded as a normal payment on the Amortization account. "Close contract" then posts the not-yet-due principal as one payoff charge, closes the account and marks the vehicle as transferred.
- **Setting `rto.cashout_requires_clear_balances` (default on):** ownership is transferred only if the boundary and costs balances are also clear. **To confirm with the owner.**
- **Termination:** future installments stop and arrears remain owed.
- **Bank loans:** diminishing-balance annuity, computed in exact integer arithmetic. The schedule is stored once when the loan is created. Payments apply to the oldest installment first, and corrections are reversals. Finance sees alerts N days before each due date (setting `loans.due_alert_days`).
- **Per-vehicle profitability:** the paid part of boundary and RTO dues attributed to the vehicle, minus loan payments. Operating expenses come in Phase 6.

## 12. Owner answers, round 5 (2026-09-27)

| Question | Answer | Design impact |
|---|---|---|
| Cashout requires all balances to be clear | **Yes** | `rto.cashout_requires_clear_balances = true` is confirmed. |
| Which amortization is subtracted for the investor share | **The driver's monthly (RTO) amortization** | Phase 6: monthly investor share per vehicle = 22 × the driver's daily boundary rate − that driver's monthly RTO amortization. No percentage split. Paid monthly. |

### Phase 5 decisions (reminders, sent manually)
- **Every morning at 08:00 Manila** (cron `/api/cron/reminders`, or the "Prepare now" button), reminders are generated into an **outbox**. Staff tap **Open SMS** (the phone's messaging app opens with the text filled in), send it, then **Mark sent**. Everything is logged.
- **Triggers:**
  - Weekly balance (Monday).
  - Missed boundary (the next morning).
  - RTO amortization 3 days before it is due.
  - RTO amortization 1 day after it is due, if still unpaid.
  - RTO milestones (25/50/75/100%).
  - Driver's license expiry (30 days before).
  
  Admins can edit each trigger's schedule, and each has a dedupe key so it is never repeated.
- **Templates are in English and Taglish.** Each driver has a preferred language (default Taglish). Amounts are written "P700.00", because the ₱ sign would cut each SMS from 160 to 70 characters. A template with an unknown `{{variable}}` is reported and never sent.
- **Opt-outs** are honoured when reminders are generated.
- **The SMS provider interface** (`src/server/sms/provider.ts`) currently has only the "manual" provider. A gateway can be added later without touching the reminder rules.
- Franchise expiry reminders go to operators and belong with Applications (Phase 7).

## 13. Phase 6 decisions: expenses, payroll, commissions, investors

The owner asked (2026-09-27) to use **Philippine Labor Code defaults, with every rate configurable**. These defaults are open for the owner and accountant to confirm:

| Topic | Default used | Setting |
|---|---|---|
| Cut-offs / pay day | 1st–15th and 16th–end, each paid on its last day | `payroll.pay_delay_days` (0) |
| Daily rate (monthly-paid) | monthly × 12 ÷ **261** | `payroll.working_days_per_year` |
| Hours per day | 8 (lates deducted per minute at the hourly rate) | `payroll.hours_per_day` |
| Premiums | Overtime 125%, rest day / special day 130%, regular holiday 200% (monthly-paid get the extra 100%, since the holiday is already in their salary), night differential 10% | `payroll.premium_rates` |
| Government deductions | Based on the monthly salary and split in half across both cut-offs (owner). Tax is withheld per cut-off by annualising (×24) against the TRAIN table. | versioned `gov_contribution_tables` |
| Cash advances | Unliquidated after 7 days → proposed as a salary deduction (owner rule). Receipts turned in become "Travel & meetings" expenses. | `payroll.ca_deduct_after_days` |
| 13th month | Basic salary earned in finalized payrolls of the year ÷ 12. Amounts above ₱90,000 are flagged for the accountant; the extra tax is not computed. | `payroll.thirteenth_month_tax_exempt_centavos` |
| Referral commission | 10% of the down payment, payable 1 month after the contract start (owner) | `commissions.referral_*` |
| Investor share | 22 × the driver's daily boundary − the driver's monthly RTO amortization (owner). A negative month is paid as ₱0.00 and flagged. | `investors.boundary_days` |

- **Contribution base:** SSS, PhilHealth and Pag-IBIG are all computed on the monthly **basic** salary. For daily-paid staff that is daily rate × 261 ÷ 12.
- **Payroll corrections:** a finalized payroll is locked in the database. Corrections go into the next payroll.
- **Payroll cost:** "Mark paid" books the payroll cost (gross + employer contributions) under "Salaries", and staff reimbursements under "Travel & meetings".
- **Record corrections:** expenses, cash advances and commissions received can only be voided, never edited or deleted.
- **Self-service views:** staff linked to a login see their own finalized payslips on the dashboard. Investors see their vehicles and monthly shares in the portal.
- **Commissions received** (from platforms or dealers) are recorded one by one, since what platforms and dealers pay for isn't specified yet.

## 14. Spec gap closing (M-A)

These are items from the full spec (`/mvp` brief, 2026-09-27) that phases 1–6 didn't cover:

- **Payment proofs from the portal.** A driver uploads a GCash, Maya or bank screenshot with the amount, reference number and date paid. Nothing is posted until finance verifies it.
  - Finance splits the amount across the driver's accounts. The split must equal the claimed amount; if the amount is wrong, finance rejects the proof with a reason the driver sees.
  - Approval records a normal payment dated the day the driver paid, with the proof as the attached receipt. The proof id is the payment's idempotency key.
  - Operations can see the queue but can't decide. A driver can have at most `portal.max_pending_proofs` proofs waiting.
- **Acknowledgement receipt PDF.** For staff at `/app/collections/receipts/[id]/pdf`, and for drivers from the portal (their own only, enforced by RLS).
- **Collect today (collector mode).** A mobile list of every driver with anything due up to today, oldest arrears first, with one tap to record a payment.
- **Close the day.** Shows boundary charged vs collected, then per collector: cash, non-cash, remitted and not yet remitted.
  - Finance's close stores an immutable snapshot of that day.
  - Payments changed after the close are flagged against the snapshot, not blocked. We didn't invent a rule to lock a closed day.
- **Vehicle maintenance log.** Records the date, work done, shop, odometer, cost and a receipt photo.
  - Optionally books a "Vehicle maintenance" expense (owner/admin and finance only), and optionally charges the driver at cost (owner rule).
  - Voiding the record voids the expense and reverses the charge together.
- **Driver platform accounts.** For example, inDrive IDs. They are unique per platform, and drivers see their own.
- **Driver alerts on the dashboard.** Triggered by N unpaid boundary days, a balance at or over a threshold, or a licence expiring soon.
  - Because payments apply oldest first, the unpaid boundary days are always the most recent ones, so their count is the run of consecutive unpaid days.
- **Reminder quiet hours.** "Open SMS" is disabled between 21:00 and 07:00 Manila time (setting `reminders.quiet_hours`).
- **Upload size.** Server actions now accept up to 9 MB. The default 1 MB rejected normal phone photos of receipts.

## 15. Public website and CRM (M-B)

- **Website at `/`.** The staff app stays at `/app`, and after sign-in users go to `/home`, which sends them to their own area.
  - Pages: the landing page, `/school` (a placeholder until the owner has details) and `/privacy`.
  - Content is edited under **Growth → Website** by owner/admin and sales. Visitors see changes on their next page load, because the content cache is refreshed on save.
  - Brand colours live in one file, `src/app/brand.css`.
  - The site has search and sharing metadata (title, description, Open Graph with a generated share image, `robots.txt`, `sitemap.xml`, JSON-LD) and is set to be indexed. The staff app stays out of search engines.
- **Inquiry form.** Consent to the privacy notice (RA 10173) is required. Two spam controls:
  - A hidden honeypot field: a submission that fills it in is silently dropped.
  - A rate limit per visitor (`crm.inquiry_rate_limit_per_hour`, default 5). Visitor IPs are stored only as a salted hash.
- **Leads from the form.** A submission becomes a lead with source "website form". If the same mobile number already has an open lead, the inquiry is added to that lead's timeline instead of creating a duplicate.
- **Assignment.** New website and Lead Ads leads go to the active sales agent with the fewest open leads. With no agents, owner/admins and sales are notified instead.
- **Notifications** are in-app (the bell in the header). SMS and email notifications wait for a provider.
- **CRM.**
  - A board with one column per configurable stage. Cards move with a stage picker (no drag-and-drop), so it works on phones.
  - Follow-ups per agent, with overdue highlighting.
  - Duplicate warning by mobile number on manual entry.
  - CSV import with a preview. Rows matching an open lead are added to that lead.
  - Losing a lead requires a reason. Moving it to a "won" stage records the conversion time.
- **Personal data.** Leads carry no generic audit trail. Instead:
  - Every stage and assignment change is written to the lead's timeline by the database.
  - Owner/admin can export a lead's data as JSON, or erase the lead with its timeline, follow-ups and notifications.
  - Only the fact of an export or erasure is kept, in `privacy_requests`.
- **Facebook Lead Ads.** A webhook at `/api/webhooks/meta` checks Meta's signature and stores each submission once, keyed on its leadgen id.
  - It is off until `crm.meta_lead_ads_enabled` is on and `META_APP_SECRET`, `META_VERIFY_TOKEN` and `META_PAGE_ACCESS_TOKEN` are set.
  - It also needs Meta app review for `leads_retrieval`.
  - Messenger leads are entered by hand (owner, round 2).
- **Staff directory.** `app.staff_directory()` lets staff see other active staff and their roles, which drop-downs need. `user_roles` itself stays private.
  - This also fixes an earlier limit: the "Received by" list on the payment form only ever showed the signed-in user to anyone but owner/admin.

## 16. Client applications (M-C)

- **New role: documentation staff.** They work applications and checklists and count as staff. They see no leads and no money screens beyond an application's own fees.
  - Because this role was added to the database's list of roles in the same migration run that uses it, the SQL role checks for it compare roles as text (`app.has_any_role_text`).
- **Configurable by owner/admin** under Applications → Settings:
  - Application types, each with a default quoted fee (seeded ₱0).
  - The status pipeline. Each status has a kind (in progress, approved, completed, on hold, cancelled), and reports count by kind.
  - Document checklists per type. The seeded lists are generic placeholders.
  - Referral commission rules per type, fixed or a percentage of the fees. None are active until the owner sets them.
- **An application** belongs to a client (a person or company, reused by mobile number). It gets a copy of its type's checklist and a quoted "Service fee" line.
  - Every status change is written to a history log by the database, with an optional note. Cancelling needs a reason.
  - The first approval time and the completion time are stamped once.
- **Checklist.** Documentation staff upload a file per item and verify it. A replacement file clears the earlier verification. An original seen at the office can be verified without a file.
- **Fees and payments** follow the money rules: void-only, with idempotent payments. Receipts use the same AR-###### series as driver payments, with a PDF. Balance = active fees − active payments.
- **Referral commission** is created once, when a referred application is first approved, from the type's rule. Amounts are fixed at creation, and finance approves and pays it on the Commissions page.
- **Leads convert to applications** from the lead page. The client is reused by mobile number, and the lead moves to its "won" stage with a timeline entry.
- **Approved driver-program applications** become driver profiles with status "applicant". If a driver already has the same mobile number, that driver is linked instead.
- **Online applications at `/apply`** create a CRM lead (or add to the person's open lead), a client and a draft application, and notify documentation staff and owner/admins.
  - The form uses the website's spam controls.
  - No fees are quoted and no files can be uploaded publicly: documents are collected after staff make contact.
- **Vehicle papers.**
  - Vehicles now have a type (ICE, EV or Hybrid; `is_ev` is derived and existing EV flags were carried over), conduction sticker, OR/CR expiry and insurance expiry.
  - Franchises can be linked to a client for renewal follow-up.
  - Expiries within 60 days are listed, and those within 30 days (both settings) are shown as urgent: on the vehicle page, on the applications list (franchises), and on the dashboard (M-D).

## 17. Cash book, dashboards and reports (M-D) and spreadsheet import (M-E)

The full decision records are in `docs/notes-m-d.md` (which records count as cash in or out and in which account, how payroll and cash advances are treated, reconciliations, performance measurements) and `docs/notes-m-e.md` (import rules: never update existing records, idempotent opening balances, pre-go-live payments kept for reference only, date and peso parsing). Deployment and operations: `docs/DEPLOYMENT.md`. Open decisions for the owner: `docs/OPEN_QUESTIONS.md`.

- Read-heavy RLS policies were rewritten (migration 0022) so the role check runs once per query instead of once per row. Same rules, and the RLS tests are unchanged; this is what brings dashboards under 2 seconds at 500 drivers × 3 years.
- Open dues and aging use `app.open_charges()`, which applies the same oldest-due-first rule as `v_charge_status` (a DB test compares them) but walks each account once. The drivers list, Collect today, the alerts, the dashboards and the vehicle report use it.

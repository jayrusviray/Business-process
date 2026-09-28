-- ============================================================================
-- M-D: cash book (accounts, manual entries, reconciliations, reassignments),
-- the v_cash_book read model, a fast open-charges function for dashboards and
-- reports, indexes for report date ranges, RLS and seeds.
--
-- Mapping of every source to the cash book is documented in docs/notes-m-d.md.
-- Role checks compare roles as text (app.has_any_role_text, migration 0018).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Guards, stamps, audit
-- ---------------------------------------------------------------------------
-- A manual entry goes to active accounts only and can't be created void.
CREATE OR REPLACE FUNCTION app.check_cash_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.voided_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a cash entry cannot be created void';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.id = NEW.account_id AND a.active)
     OR (NEW.counter_account_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.id = NEW.counter_account_id AND a.active)) THEN
    RAISE EXCEPTION 'the cash account is inactive or does not exist' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_insert BEFORE INSERT ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION app.check_cash_transaction();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.cash_transactions FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.cash_accounts FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.cash_accounts FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.cash_accounts FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- Reassignments: target must be an active account; append-only.
CREATE OR REPLACE FUNCTION app.check_cash_reassignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.id = NEW.account_id AND a.active) THEN
    RAISE EXCEPTION 'the cash account is inactive or does not exist' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_insert BEFORE INSERT ON public.cash_reassignments FOR EACH ROW EXECUTE FUNCTION app.check_cash_reassignment();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.cash_reassignments FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.cash_reassignments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.cash_reassignments FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.cash_reassignments FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Read model: every inflow and outflow, one row per leg.
--   direction      'in' | 'out'; amount_centavos is always positive
--   signed         in = +amount, out = −amount (a balance is SUM(signed))
--   account_id     manual entries: as entered. Module records: the latest
--                  cash_reassignments row, else the account whose payment_method
--                  matches the record's method (or, for records without one,
--                  the method chosen in setting cashbook.default_routing), else
--                  the account for method 'other'.
-- Voided / reversed rows never appear. Cash-advance liquidations are left out
-- (the cash left when the advance was given). Owner/admin and finance only.
-- security_invoker: the caller's RLS applies to every source table.
-- ---------------------------------------------------------------------------
-- Where each routing key lands: a payment method's own account; for records
-- without a method, the method chosen in cashbook.default_routing; else 'other'.
CREATE VIEW public.v_cash_routes WITH (security_invoker = true) AS
SELECT k.route_key, COALESCE(ca.id, oa.id) AS account_id
FROM unnest(ARRAY['cash', 'gcash', 'maya', 'bank_transfer', 'other', 'check', 'payroll', 'loan_payment', 'investor_payout',
  'commission_payout', 'commission_received', 'cash_advance', 'driver_bonus']) AS k(route_key)
LEFT JOIN public.cash_accounts ca ON ca.payment_method = CASE
  WHEN k.route_key IN ('cash', 'gcash', 'maya', 'bank_transfer', 'other') THEN k.route_key
  ELSE COALESCE((SELECT s.value ->> k.route_key FROM public.app_settings s WHERE s.key = 'cashbook.default_routing'), 'other') END
LEFT JOIN public.cash_accounts oa ON oa.payment_method = 'other';
--> statement-breakpoint
-- The latest reassignment of each module record.
CREATE VIEW public.v_cash_reassigned WITH (security_invoker = true) AS
SELECT DISTINCT ON (r.source_type, r.source_id) r.source_type, r.source_id, r.account_id
FROM public.cash_reassignments r
ORDER BY r.source_type, r.source_id, r.created_at DESC, r.id DESC;
--> statement-breakpoint

CREATE VIEW public.v_cash_book WITH (security_invoker = true) AS
WITH src AS (
  -- Driver payments, one row per account line (boundary / RTO amortization / costs & deposit).
  SELECT 'payment'::text AS source_type, p.id AS source_id, da.kind::text AS line_key, p.business_date AS entry_date,
    'in'::text AS direction, pl.amount_centavos,
    (CASE da.kind WHEN 'boundary' THEN 'boundary' WHEN 'amortization' THEN 'rto' ELSE 'driver_charges' END)::text AS category,
    ''::text AS subcategory, p.method::text AS method, p.method::text AS route_key, NULL::uuid AS fixed_account_id,
    (d.last_name || ', ' || d.first_name)::text AS counterparty, ('Payment ' || p.receipt_no)::text AS description,
    COALESCE(p.reference_no, '')::text AS reference, p.created_at
  FROM public.payments p
  JOIN public.payment_lines pl ON pl.payment_id = p.id
  JOIN public.driver_accounts da ON da.id = pl.account_id
  JOIN public.drivers d ON d.id = p.driver_id
  WHERE NOT EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id)
  UNION ALL
  -- Documentation / activation fees paid on applications.
  SELECT 'application_payment', ap.id, '', ap.received_on, 'in', ap.amount_centavos, 'documentation_fees', t.label,
    ap.method::text, ap.method::text, NULL, c.name, 'Fee payment ' || ap.receipt_no || ' · ' || a.app_no, COALESCE(ap.reference_no, ''), ap.created_at
  FROM public.application_payments ap
  JOIN public.applications a ON a.id = ap.application_id
  JOIN public.application_types t ON t.key = a.type_key
  JOIN public.clients c ON c.id = a.client_id
  WHERE ap.voided_at IS NULL
  UNION ALL
  -- Commissions TransRev receives from platforms and dealers.
  SELECT 'commission_received', cr.id, '', cr.received_on, 'in', cr.amount_centavos, 'commission_received', cr.source_type,
    NULL, 'commission_received', NULL, cr.counterparty, cr.description, cr.reference, cr.created_at
  FROM public.commissions_received cr
  WHERE cr.voided_at IS NULL
  UNION ALL
  -- Referral commissions paid out (driver referrals).
  SELECT 'referral_commission', rc.id, '', rc.paid_on, 'out', rc.amount_centavos, 'commission_payout', 'Driver referral',
    NULL, 'commission_payout', NULL, rc.referrer_name, 'Referral commission · ' || c.contract_no, COALESCE(rc.paid_reference, ''), rc.created_at
  FROM public.referral_commissions rc
  JOIN public.rto_contracts c ON c.id = rc.rto_contract_id
  WHERE rc.status = 'paid' AND rc.paid_on IS NOT NULL AND rc.amount_centavos > 0
  UNION ALL
  -- Referral commissions paid out (applications).
  SELECT 'application_commission', ac.id, '', ac.paid_on, 'out', ac.amount_centavos, 'commission_payout', 'Application referral',
    NULL, 'commission_payout', NULL, ac.referrer_name, 'Referral commission · ' || a.app_no, COALESCE(ac.paid_reference, ''), ac.created_at
  FROM public.application_commissions ac
  JOIN public.applications a ON a.id = ac.application_id
  WHERE ac.status = 'paid' AND ac.paid_on IS NOT NULL AND ac.amount_centavos > 0
  UNION ALL
  -- Investor shares paid.
  SELECT 'investor_payout', ip.id, '', ip.paid_on, 'out', ip.payable_centavos, 'investor_payout', '',
    NULL, 'investor_payout', NULL, i.name, 'Investor share ' || to_char(ip.month, 'YYYY-MM') || ' · ' || v.plate_no,
    COALESCE(ip.reference, ''), ip.created_at
  FROM public.investor_payouts ip
  JOIN public.investors i ON i.id = ip.investor_id
  JOIN public.vehicles v ON v.id = ip.vehicle_id
  WHERE ip.status = 'paid' AND ip.paid_on IS NOT NULL AND ip.payable_centavos > 0
  UNION ALL
  -- Vehicle loan amortization paid to banks/dealers. A corrected payment and its correction both drop out.
  SELECT 'loan_payment', lp.id, '', lp.paid_on, 'out', lp.amount_centavos, 'loan_amortization', l.lender,
    NULL, 'loan_payment', NULL, l.lender, 'Loan payment · ' || v.plate_no, lp.reference, lp.created_at
  FROM public.loan_payments lp
  JOIN public.vehicle_loans l ON l.id = lp.loan_id
  JOIN public.vehicles v ON v.id = l.vehicle_id
  WHERE lp.reverses_payment_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.loan_payments r WHERE r.reverses_payment_id = lp.id)
  UNION ALL
  -- Expenses. paid_via 'payroll' = payroll cost booked on the pay date (gross + employer contributions,
  -- staff reimbursements, 13th month). paid_via 'cash_advance' = spending out of an advance: excluded.
  SELECT 'expense', e.id, '', e.expense_date, 'out', e.amount_centavos,
    CASE WHEN e.paid_via = 'payroll' THEN 'payroll' ELSE 'expense' END, ec.name,
    e.paid_via, e.paid_via, NULL, e.vendor, e.description, e.reference, e.created_at
  FROM public.expenses e
  JOIN public.expense_categories ec ON ec.id = e.category_id
  WHERE e.voided_at IS NULL AND e.paid_via <> 'cash_advance'
  UNION ALL
  -- Cash advances handed to staff.
  SELECT 'cash_advance', ca.id, '', ca.given_on, 'out', ca.amount_centavos, 'cash_advance', '',
    NULL, 'cash_advance', NULL, em.last_name || ', ' || em.first_name, 'Cash advance · ' || ca.purpose, '', ca.created_at
  FROM public.cash_advances ca
  JOIN public.employees em ON em.id = ca.employee_id
  WHERE ca.voided_at IS NULL
  UNION ALL
  -- Cash advances coming back: cash returned, or deducted from salary in a PAID payroll
  -- (the payroll outflow above is gross, so the deducted part comes back here).
  SELECT 'cash_advance_settlement', s.id, '', s.settled_on, 'in', s.amount_centavos, 'cash_advance_return',
    CASE s.kind WHEN 'cash_return' THEN 'Cash returned' ELSE 'Salary deduction' END,
    NULL, CASE s.kind WHEN 'cash_return' THEN 'cash_advance' ELSE 'payroll' END, NULL,
    em.last_name || ', ' || em.first_name,
    CASE s.kind WHEN 'cash_return' THEN 'Cash advance returned' ELSE 'Cash advance deducted from salary' END, '', s.created_at
  FROM public.cash_advance_settlements s
  JOIN public.cash_advances ca ON ca.id = s.cash_advance_id
  JOIN public.employees em ON em.id = ca.employee_id
  WHERE ca.voided_at IS NULL
    AND (s.kind = 'cash_return'
      OR (s.kind = 'payroll_deduction' AND EXISTS (
        SELECT 1 FROM public.payroll_lines pl JOIN public.payroll_periods pp ON pp.id = pl.period_id
        WHERE pl.id = s.payroll_line_id AND pp.status = 'paid')))
  UNION ALL
  -- Quota bonuses paid in cash (credits to the driver's balance move no money).
  SELECT 'bonus_award', b.id, '', b.paid_on, 'out', b.amount_centavos, 'driver_bonus', '',
    NULL, 'driver_bonus', NULL, d.last_name || ', ' || d.first_name, 'Quota bonus (cash)', b.reference, b.created_at
  FROM public.bonus_awards b
  JOIN public.drivers d ON d.id = b.driver_id
  WHERE b.payout_mode = 'cash' AND b.voided_at IS NULL
  UNION ALL
  -- Manual entries; a transfer's first leg leaves the source account.
  SELECT 'cash_transaction', t.id, CASE WHEN t.category = 'transfer' THEN 'out' ELSE '' END, t.entry_date,
    CASE WHEN t.category IN ('opening_balance', 'platform_revenue', 'investor_capital', 'owner_capital', 'other_in') THEN 'in' ELSE 'out' END,
    t.amount_centavos, CASE WHEN t.category = 'transfer' THEN 'transfer_out' ELSE t.category END, '',
    NULL, NULL, t.account_id, t.counterparty, t.description, t.reference, t.created_at
  FROM public.cash_transactions t
  WHERE t.voided_at IS NULL
  UNION ALL
  -- ...and the transfer's second leg arrives in the destination account.
  SELECT 'cash_transaction', t.id, 'in', t.entry_date, 'in', t.amount_centavos, 'transfer_in', '',
    NULL, NULL, t.counter_account_id, t.counterparty, t.description, t.reference, t.created_at
  FROM public.cash_transactions t
  WHERE t.voided_at IS NULL AND t.category = 'transfer'
)
SELECT s.source_type, s.source_id, s.line_key, s.entry_date, s.direction, s.amount_centavos,
  (CASE s.direction WHEN 'in' THEN s.amount_centavos ELSE -s.amount_centavos END)::bigint AS signed_centavos,
  s.category, s.subcategory, s.method, s.counterparty, s.description, s.reference,
  COALESCE(s.fixed_account_id, lr.account_id, ra.account_id,
    (SELECT o.id FROM public.cash_accounts o WHERE o.payment_method = 'other')) AS account_id,
  (lr.account_id IS NOT NULL) AS reassigned,
  s.created_at
FROM src s
LEFT JOIN public.v_cash_reassigned lr ON s.fixed_account_id IS NULL AND lr.source_type = s.source_type AND lr.source_id = s.source_id
LEFT JOIN public.v_cash_routes ra ON ra.route_key = s.route_key
-- Owner/admin and finance only (system jobs, which bypass RLS, are allowed). Evaluated once per query.
WHERE (SELECT current_user::text <> 'authenticated' OR app.has_any_role_text('owner_admin', 'finance'));
--> statement-breakpoint

-- Lean twin of v_cash_book for balances and totals: one row per movement (a
-- driver payment once, not per account line), no names. MUST give the same
-- per-account sums as v_cash_book; test/db/cashbook.test.ts checks it.
-- operating = false for transfers and opening balances.
CREATE VIEW public.v_cash_movements WITH (security_invoker = true) AS
WITH src AS (
  SELECT 'payment'::text AS source_type, p.id AS source_id, ''::text AS line_key, p.business_date AS entry_date,
    p.amount_centavos::bigint AS signed_centavos, p.method::text AS route_key, NULL::uuid AS fixed_account_id, true AS operating
  FROM public.payments p
  WHERE NOT EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id)
  UNION ALL
  SELECT 'application_payment', ap.id, '', ap.received_on, ap.amount_centavos, ap.method::text, NULL, true
  FROM public.application_payments ap WHERE ap.voided_at IS NULL
  UNION ALL
  SELECT 'commission_received', cr.id, '', cr.received_on, cr.amount_centavos, 'commission_received', NULL, true
  FROM public.commissions_received cr WHERE cr.voided_at IS NULL
  UNION ALL
  SELECT 'referral_commission', rc.id, '', rc.paid_on, -rc.amount_centavos, 'commission_payout', NULL, true
  FROM public.referral_commissions rc WHERE rc.status = 'paid' AND rc.paid_on IS NOT NULL AND rc.amount_centavos > 0
  UNION ALL
  SELECT 'application_commission', ac.id, '', ac.paid_on, -ac.amount_centavos, 'commission_payout', NULL, true
  FROM public.application_commissions ac WHERE ac.status = 'paid' AND ac.paid_on IS NOT NULL AND ac.amount_centavos > 0
  UNION ALL
  SELECT 'investor_payout', ip.id, '', ip.paid_on, -ip.payable_centavos, 'investor_payout', NULL, true
  FROM public.investor_payouts ip WHERE ip.status = 'paid' AND ip.paid_on IS NOT NULL AND ip.payable_centavos > 0
  UNION ALL
  SELECT 'loan_payment', lp.id, '', lp.paid_on, -lp.amount_centavos, 'loan_payment', NULL, true
  FROM public.loan_payments lp
  WHERE lp.reverses_payment_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.loan_payments r WHERE r.reverses_payment_id = lp.id)
  UNION ALL
  SELECT 'expense', e.id, '', e.expense_date, -e.amount_centavos, e.paid_via, NULL, true
  FROM public.expenses e WHERE e.voided_at IS NULL AND e.paid_via <> 'cash_advance'
  UNION ALL
  SELECT 'cash_advance', ca.id, '', ca.given_on, -ca.amount_centavos, 'cash_advance', NULL, true
  FROM public.cash_advances ca WHERE ca.voided_at IS NULL
  UNION ALL
  SELECT 'cash_advance_settlement', s.id, '', s.settled_on, s.amount_centavos,
    CASE s.kind WHEN 'cash_return' THEN 'cash_advance' ELSE 'payroll' END, NULL, true
  FROM public.cash_advance_settlements s JOIN public.cash_advances ca ON ca.id = s.cash_advance_id
  WHERE ca.voided_at IS NULL
    AND (s.kind = 'cash_return'
      OR (s.kind = 'payroll_deduction' AND EXISTS (
        SELECT 1 FROM public.payroll_lines pl JOIN public.payroll_periods pp ON pp.id = pl.period_id
        WHERE pl.id = s.payroll_line_id AND pp.status = 'paid')))
  UNION ALL
  SELECT 'bonus_award', b.id, '', b.paid_on, -b.amount_centavos, 'driver_bonus', NULL, true
  FROM public.bonus_awards b WHERE b.payout_mode = 'cash' AND b.voided_at IS NULL
  UNION ALL
  SELECT 'cash_transaction', t.id, CASE WHEN t.category = 'transfer' THEN 'out' ELSE '' END, t.entry_date,
    CASE WHEN t.category IN ('opening_balance', 'platform_revenue', 'investor_capital', 'owner_capital', 'other_in') THEN t.amount_centavos ELSE -t.amount_centavos END,
    NULL, t.account_id, t.category NOT IN ('transfer', 'opening_balance')
  FROM public.cash_transactions t WHERE t.voided_at IS NULL
  UNION ALL
  SELECT 'cash_transaction', t.id, 'in', t.entry_date, t.amount_centavos, NULL, t.counter_account_id, false
  FROM public.cash_transactions t WHERE t.voided_at IS NULL AND t.category = 'transfer'
)
SELECT s.source_type, s.source_id, s.line_key, s.entry_date, s.signed_centavos,
  COALESCE(s.fixed_account_id, lr.account_id, ra.account_id,
    (SELECT o.id FROM public.cash_accounts o WHERE o.payment_method = 'other')) AS account_id,
  s.operating
FROM src s
LEFT JOIN public.v_cash_reassigned lr ON s.fixed_account_id IS NULL AND lr.source_type = s.source_type AND lr.source_id = s.source_id
LEFT JOIN public.v_cash_routes ra ON ra.route_key = s.route_key
WHERE (SELECT current_user::text <> 'authenticated' OR app.has_any_role_text('owner_admin', 'finance'));
--> statement-breakpoint

-- Book balance of one account at the end of a day.
CREATE OR REPLACE FUNCTION app.cash_balance(p_account uuid, p_as_of date) RETURNS bigint
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(SUM(c.signed_centavos), 0)::bigint FROM public.v_cash_movements c
  WHERE c.account_id = p_account AND c.entry_date <= p_as_of
$$;
--> statement-breakpoint

-- Reconciliations are immutable snapshots: the database fills in the book balance.
CREATE OR REPLACE FUNCTION app.snapshot_cash_reconciliation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.as_of_date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RAISE EXCEPTION 'you can''t reconcile a day that hasn''t happened yet' USING ERRCODE = 'check_violation';
  END IF;
  NEW.system_centavos := app.cash_balance(NEW.account_id, NEW.as_of_date);
  IF NEW.created_by IS NULL THEN NEW.created_by := app.current_actor(); END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER snapshot BEFORE INSERT ON public.cash_reconciliations FOR EACH ROW EXECUTE FUNCTION app.snapshot_cash_reconciliation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.cash_reconciliations FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.cash_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.cash_reconciliations FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Open (unpaid) charges, fast. Same rule as v_charge_status / allocateAccount
-- (oldest due first within an account), computed from the other end: an
-- account's balance is exactly what its NEWEST active debits still owe, so we
-- walk debits newest-first until the balance is used up. Only accounts with a
-- positive balance are visited, so the cost grows with arrears, not history.
-- p_as_of: only entries with business_date <= p_as_of (NULL = everything).
-- SECURITY INVOKER: the caller's RLS applies. test/db/cashbook.test.ts checks
-- it against v_charge_status.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.open_charges(p_as_of date DEFAULT NULL)
RETURNS TABLE (entry_id uuid, account_id uuid, driver_id uuid, account_kind public.account_kind, entry_type public.ledger_entry_type,
  due_date date, vehicle_id uuid, amount_centavos bigint, outstanding_centavos bigint)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  acc record;
  deb record;
  v_kind public.account_kind;
  v_left bigint;
BEGIN
  FOR acc IN
    SELECT e.account_id AS id, SUM(e.amount_centavos)::bigint AS balance
    FROM public.ledger_entries e
    WHERE p_as_of IS NULL OR e.business_date <= p_as_of
    GROUP BY e.account_id
    HAVING SUM(e.amount_centavos) > 0
  LOOP
    SELECT a.kind INTO v_kind FROM public.driver_accounts a WHERE a.id = acc.id;
    v_left := acc.balance;
    -- Newest first along ledger_open_walk_idx; the loop stops as soon as the balance is covered.
    FOR deb IN
      SELECT e.id, e.driver_id, e.entry_type, e.due_date, e.vehicle_id, e.amount_centavos
      FROM public.ledger_entries e
      WHERE e.account_id = acc.id AND e.amount_centavos > 0 AND e.entry_type <> 'reversal'
        AND (p_as_of IS NULL OR e.business_date <= p_as_of)
      ORDER BY e.due_date DESC, e.seq DESC
    LOOP
      -- A reversed debit no longer exists (its reversal is part of the balance too).
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.ledger_entries r
        WHERE r.reverses_entry_id = deb.id AND (p_as_of IS NULL OR r.business_date <= p_as_of));
      entry_id := deb.id;
      account_id := acc.id;
      driver_id := deb.driver_id;
      account_kind := v_kind;
      entry_type := deb.entry_type;
      due_date := deb.due_date;
      vehicle_id := deb.vehicle_id;
      amount_centavos := deb.amount_centavos;
      outstanding_centavos := LEAST(deb.amount_centavos, v_left);
      RETURN NEXT;
      v_left := v_left - outstanding_centavos;
      EXIT WHEN v_left <= 0;
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.open_charges(date), app.cash_balance(uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.open_charges(date), app.cash_balance(uuid, date) TO authenticated, service_role;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Indexes for dashboards and date-range reports
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS payments_business_date_idx ON public.payments (business_date);
--> statement-breakpoint
-- Newest-first walk of an account's debits (app.open_charges): read in index order, no sort.
CREATE INDEX IF NOT EXISTS ledger_open_walk_idx ON public.ledger_entries (account_id, due_date DESC, seq DESC)
  WHERE amount_centavos > 0 AND entry_type <> 'reversal';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ledger_due_date_idx ON public.ledger_entries (due_date) WHERE amount_centavos > 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS commissions_received_date_idx ON public.commissions_received (received_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loan_payments_paid_on_idx ON public.loan_payments (paid_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cash_advances_given_on_idx ON public.cash_advances (given_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS applications_created_at_idx ON public.applications (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS applications_approved_at_idx ON public.applications (approved_at);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS performance (NFR: dashboards < 2 s with 500 drivers × 3 years).
-- Postgres evaluates a policy's function calls once PER ROW; on ~1M ledger rows
-- app.has_any_role() alone cost ~10 s per query. Wrapping the row-independent
-- calls in a scalar sub-select makes them an InitPlan, evaluated ONCE per query.
-- Same logic, same results; only the read policies of large tables change.
-- ---------------------------------------------------------------------------
ALTER POLICY ledger_select ON public.ledger_entries
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY payments_select ON public.payments
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
-- Was: the payment is visible (A/F/O, or the driver's own). Same rule, written out.
ALTER POLICY payment_lines_select ON public.payment_lines
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations'))
    OR EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_lines.payment_id AND p.driver_id = (SELECT app.current_driver_id())));
--> statement-breakpoint
ALTER POLICY payment_voids_select ON public.payment_voids
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations'))
    OR EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_voids.payment_id AND p.driver_id = (SELECT app.current_driver_id())));
--> statement-breakpoint
ALTER POLICY accounts_select ON public.driver_accounts
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY plans_select ON public.boundary_plans
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY assignments_select ON public.vehicle_assignments
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY rto_select ON public.rto_contracts
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY quota_results_select ON public.quota_results
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY bonus_awards_select ON public.bonus_awards
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY payment_proofs_select ON public.payment_proofs
  USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')) OR driver_id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY drivers_select ON public.drivers
  USING ((SELECT app.is_staff()) OR id = (SELECT app.current_driver_id()));
--> statement-breakpoint
ALTER POLICY remittances_select ON public.remittances
  USING ((SELECT app.has_any_role('owner_admin', 'finance')) OR collector_id = (SELECT auth.uid()));
--> statement-breakpoint
-- Was: the remittance is visible (A/F, or the collector's own). Same rule, written out.
ALTER POLICY remittance_payments_select ON public.remittance_payments
  USING ((SELECT app.has_any_role('owner_admin', 'finance'))
    OR EXISTS (SELECT 1 FROM public.remittances r WHERE r.id = remittance_payments.remittance_id AND r.collector_id = (SELECT auth.uid())));
--> statement-breakpoint
ALTER POLICY vehicles_select ON public.vehicles USING ((SELECT app.has_any_role('owner_admin', 'finance', 'operations')));
--> statement-breakpoint
ALTER POLICY vehicles_select_own_driver ON public.vehicles
  USING (EXISTS (SELECT 1 FROM public.vehicle_assignments va WHERE va.vehicle_id = vehicles.id AND va.driver_id = (SELECT app.current_driver_id())));
--> statement-breakpoint
ALTER POLICY vehicles_select_own_investor ON public.vehicles USING (investor_id = (SELECT app.current_investor_id()));
--> statement-breakpoint
ALTER POLICY loans_select ON public.vehicle_loans USING ((SELECT app.has_any_role('owner_admin', 'finance')));
--> statement-breakpoint
ALTER POLICY loan_lines_select ON public.loan_schedule_lines USING ((SELECT app.has_any_role('owner_admin', 'finance')));
--> statement-breakpoint
ALTER POLICY loan_payments_select ON public.loan_payments USING ((SELECT app.has_any_role('owner_admin', 'finance')));
--> statement-breakpoint
ALTER POLICY profiles_select ON public.profiles USING (id = (SELECT auth.uid()) OR (SELECT app.is_staff()));
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_categories', 'recurring_expenses', 'expenses', 'budgets', 'employees', 'payroll_periods',
    'payroll_lines', 'cash_advances', 'cash_advance_settlements', 'thirteenth_month_payouts', 'referral_commissions',
    'commissions_received', 'investors', 'investor_payouts'] LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I
      USING ((SELECT app.has_any_role(''owner_admin'', ''finance'')))
      WITH CHECK ((SELECT app.has_any_role(''owner_admin'', ''finance'')))', t || '_finance_all', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER POLICY investor_payouts_own ON public.investor_payouts USING (investor_id = (SELECT app.current_investor_id()));
--> statement-breakpoint
ALTER POLICY investors_own ON public.investors USING (id = (SELECT app.current_investor_id()));
--> statement-breakpoint
ALTER POLICY employees_own ON public.employees USING (id = (SELECT app.current_employee_id()));
--> statement-breakpoint
ALTER POLICY payroll_lines_own ON public.payroll_lines
  USING (employee_id = (SELECT app.current_employee_id())
    AND EXISTS (SELECT 1 FROM public.payroll_periods p WHERE p.id = payroll_lines.period_id AND p.status <> 'draft'));
--> statement-breakpoint
ALTER POLICY payroll_periods_own ON public.payroll_periods USING (status <> 'draft' AND (SELECT app.current_employee_id()) IS NOT NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS: owner/admin and finance only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.cash_accounts, public.cash_transactions, public.cash_reconciliations, public.cash_reassignments,
  public.v_cash_book, public.v_cash_movements, public.v_cash_routes, public.v_cash_reassigned FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.cash_accounts TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.cash_transactions, public.cash_reconciliations, public.cash_reassignments TO authenticated;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON public.cash_transactions TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.v_cash_book, public.v_cash_movements, public.v_cash_routes, public.v_cash_reassigned TO authenticated;
--> statement-breakpoint
ALTER TABLE public.cash_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_reconciliations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_reassignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_accounts', 'cash_transactions', 'cash_reconciliations', 'cash_reassignments'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING ((SELECT app.has_any_role_text(''owner_admin'', ''finance'')))', t || '_select', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY cash_accounts_insert ON public.cash_accounts FOR INSERT TO authenticated
  WITH CHECK ((SELECT app.has_any_role_text('owner_admin', 'finance')));
--> statement-breakpoint
CREATE POLICY cash_accounts_update ON public.cash_accounts FOR UPDATE TO authenticated
  USING ((SELECT app.has_any_role_text('owner_admin', 'finance')))
  WITH CHECK ((SELECT app.has_any_role_text('owner_admin', 'finance')));
--> statement-breakpoint
CREATE POLICY cash_transactions_insert ON public.cash_transactions FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND (SELECT app.has_any_role_text('owner_admin', 'finance')));
--> statement-breakpoint
CREATE POLICY cash_transactions_void ON public.cash_transactions FOR UPDATE TO authenticated
  USING ((SELECT app.has_any_role_text('owner_admin', 'finance')))
  WITH CHECK (voided_by = auth.uid() AND (SELECT app.has_any_role_text('owner_admin', 'finance')));
--> statement-breakpoint
CREATE POLICY cash_reconciliations_insert ON public.cash_reconciliations FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND (SELECT app.has_any_role_text('owner_admin', 'finance')));
--> statement-breakpoint
CREATE POLICY cash_reassignments_insert ON public.cash_reassignments FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND (SELECT app.has_any_role_text('owner_admin', 'finance')));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:cashbook_security', true);
--> statement-breakpoint
INSERT INTO public.cash_accounts (name, kind, payment_method, sort) VALUES
  ('Cash on hand', 'cash', 'cash', 10),
  ('GCash', 'ewallet', 'gcash', 20),
  ('Maya', 'ewallet', 'maya', 30),
  ('BDO bank', 'bank', 'bank_transfer', 40),
  ('Other', 'other', 'other', 90)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('cashbook.default_routing',
   '{"payroll":"other","loan_payment":"other","investor_payout":"other","commission_payout":"other","commission_received":"other","cash_advance":"cash","driver_bonus":"cash","check":"bank_transfer"}',
   'Cash book: which account (by payment method) receives records that have no payment method of their own: payroll, loan payments, investor payouts, commission payouts, commissions received, cash advances, cash bonuses; and expenses paid by check. "other" = the Other account until the owner decides. A single record can still be moved to another account from the cash book.'),
  ('dashboard.aging_bucket_days', '[7, 15, 30]',
   'Aging buckets for driver balances: 1–7, 8–15, 16–30 and over 30 days past due (spec 5).'),
  ('dashboard.rto_nearing_completion_installments', '3',
   'RTO contracts with this many monthly installments or fewer left to pay are shown as nearing completion.'),
  ('dashboard.upcoming_payables_days', '14',
   'Upcoming payables on the dashboard: vehicle loan dues, recurring bills and payroll due within this many days.'),
  ('reports.daily_email_to', '[]',
   'Email the Daily Collection Report every night to these addresses. Empty = off. Also needs RESEND_API_KEY and REPORTS_EMAIL_FROM.')
ON CONFLICT (key) DO NOTHING;

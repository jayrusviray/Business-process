-- ============================================================================
-- Phase 2 money engine: integrity rules, append-only guards, allocation views,
-- audit triggers and RLS. See CLAUDE.md "Money rules" and docs/00-phase0-proposal.md §6.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- No overlapping assignments / plans (btree_gist lets uuid columns join a GiST exclusion).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
--> statement-breakpoint
ALTER TABLE public.vehicle_assignments ADD CONSTRAINT assignments_no_vehicle_overlap
  EXCLUDE USING gist (vehicle_id WITH =, daterange(start_date, end_date, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE public.vehicle_assignments ADD CONSTRAINT assignments_no_driver_overlap
  EXCLUDE USING gist (driver_id WITH =, daterange(start_date, end_date, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE public.boundary_plans ADD CONSTRAINT boundary_plans_no_overlap
  EXCLUDE USING gist (driver_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_driver_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id FROM public.drivers d
  JOIN public.profiles p ON p.id = d.profile_id
  WHERE d.profile_id = auth.uid() AND p.status = 'active'
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_driver_id() TO authenticated, service_role;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Ledger integrity (runs for every insert, including system jobs).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.check_ledger_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_account public.driver_accounts%ROWTYPE;
  v_orig    public.ledger_entries%ROWTYPE;
  v_payment public.payments%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM public.driver_accounts WHERE id = NEW.account_id;
  IF v_account.driver_id IS DISTINCT FROM NEW.driver_id THEN
    RAISE EXCEPTION 'ledger entry driver does not match account driver';
  END IF;

  IF (NEW.entry_type = 'boundary_charge' AND v_account.kind <> 'boundary')
     OR (NEW.entry_type = 'amortization_charge' AND v_account.kind <> 'amortization')
     OR (NEW.entry_type IN ('cost_charge', 'deposit_charge') AND v_account.kind <> 'charges') THEN
    RAISE EXCEPTION '% cannot be posted to a % account', NEW.entry_type, v_account.kind;
  END IF;

  IF NEW.entry_type = 'reversal' THEN
    SELECT * INTO v_orig FROM public.ledger_entries WHERE id = NEW.reverses_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reversed entry does not exist';
    END IF;
    IF v_orig.entry_type = 'reversal' THEN
      RAISE EXCEPTION 'a reversal cannot be reversed; post a new entry instead';
    END IF;
    IF v_orig.account_id <> NEW.account_id OR NEW.amount_centavos <> -v_orig.amount_centavos THEN
      RAISE EXCEPTION 'a reversal must be on the same account for exactly the opposite amount';
    END IF;
  END IF;

  IF NEW.entry_type = 'payment' THEN
    SELECT * INTO v_payment FROM public.payments WHERE id = NEW.payment_id;
    IF v_payment.driver_id IS DISTINCT FROM NEW.driver_id THEN
      RAISE EXCEPTION 'payment belongs to a different driver';
    END IF;
  END IF;

  IF NEW.created_by IS NULL THEN
    NEW.created_by := app.current_actor();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_entry BEFORE INSERT ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.check_ledger_entry();
--> statement-breakpoint

-- Payment lines must belong to the payment's driver, and must add up to the payment (checked at commit).
CREATE OR REPLACE FUNCTION app.check_payment_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments p
    JOIN public.driver_accounts a ON a.driver_id = p.driver_id
    JOIN public.ledger_entries e ON e.id = NEW.ledger_entry_id
    WHERE p.id = NEW.payment_id AND a.id = NEW.account_id
      AND e.payment_id = p.id AND e.account_id = a.id AND e.amount_centavos = -NEW.amount_centavos
  ) THEN
    RAISE EXCEPTION 'payment line does not match its payment, account or ledger entry';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_line BEFORE INSERT ON public.payment_lines
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_line();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.check_payment_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_lines bigint;
BEGIN
  SELECT COALESCE(SUM(amount_centavos), 0) INTO v_lines FROM public.payment_lines WHERE payment_id = NEW.id;
  IF v_lines <> NEW.amount_centavos THEN
    RAISE EXCEPTION 'payment % lines total % but payment is %', NEW.receipt_no, v_lines, NEW.amount_centavos;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_balanced AFTER INSERT ON public.payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_payment_balanced();
--> statement-breakpoint

-- Voiding a payment reverses every ledger credit it created, atomically.
CREATE OR REPLACE FUNCTION app.apply_payment_void() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.ledger_entries
    (account_id, driver_id, entry_type, amount_centavos, business_date, reverses_entry_id, memo, reason, created_by)
  SELECT e.account_id, e.driver_id, 'reversal', -e.amount_centavos,
         (now() AT TIME ZONE 'Asia/Manila')::date, e.id,
         'Void of payment ' || p.receipt_no, NEW.reason, NEW.voided_by
  FROM public.ledger_entries e
  JOIN public.payments p ON p.id = e.payment_id
  WHERE e.payment_id = NEW.payment_id AND e.entry_type = 'payment'
    AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER apply_void AFTER INSERT ON public.payment_voids
  FOR EACH ROW EXECUTE FUNCTION app.apply_payment_void();
--> statement-breakpoint

-- Plans are versioned: only effective_to may change, and never to before an already-posted charge.
CREATE OR REPLACE FUNCTION app.guard_plan_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_last date;
BEGIN
  IF (to_jsonb(NEW) - 'effective_to' - 'updated_at' - 'updated_by' - 'notes')
     IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to' - 'updated_at' - 'updated_by' - 'notes') THEN
    RAISE EXCEPTION 'boundary plans are versioned: end this plan and create a new one instead of editing it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.effective_to IS NOT NULL THEN
    SELECT MAX(e.business_date) INTO v_last FROM public.ledger_entries e
    WHERE e.plan_id = NEW.id AND e.entry_type = 'boundary_charge'
      AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id);
    IF v_last IS NOT NULL AND NEW.effective_to < v_last THEN
      RAISE EXCEPTION 'cannot end plan on % because charges are already posted through %; reverse them first',
        NEW.effective_to, v_last;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.boundary_plans
  FOR EACH ROW EXECUTE FUNCTION app.guard_plan_update();
--> statement-breakpoint

-- Accounts: only closed_on may change.
CREATE OR REPLACE FUNCTION app.guard_account_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - 'closed_on') IS DISTINCT FROM (to_jsonb(OLD) - 'closed_on') THEN
    RAISE EXCEPTION 'only closed_on can change on a driver account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.driver_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_account_update();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Append-only financial tables
-- ---------------------------------------------------------------------------
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.payments FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.payment_lines FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.payment_voids FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.remittances FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.remittance_payments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.driver_accounts FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.boundary_plans FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.drivers FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.vehicle_assignments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Stamping + audit
-- ---------------------------------------------------------------------------
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.franchises FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.vehicle_assignments FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.holidays FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.driver_accounts FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.boundary_plans FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.drivers FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.franchises FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_assignments FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.holidays FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('date');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.driver_accounts FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.boundary_plans FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.payment_voids FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('payment_id');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.remittances FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Allocation views (oldest due first, within an account).
-- MUST stay equivalent to src/lib/ledger/allocation.ts; a test compares them.
--   * A reversal and the entry it reverses cancel out and are both excluded.
--   * Remaining debits are ordered by (due_date, seq); total credits fill them in order.
-- security_invoker = true → the caller's RLS applies to the underlying tables.
-- ---------------------------------------------------------------------------
CREATE VIEW public.v_charge_status WITH (security_invoker = true) AS
WITH active AS (
  SELECT e.* FROM public.ledger_entries e
  WHERE e.entry_type <> 'reversal'
    AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.reverses_entry_id = e.id)
),
credits AS (
  SELECT account_id, -SUM(amount_centavos) AS total
  FROM active WHERE amount_centavos < 0 GROUP BY account_id
),
debits AS (
  SELECT a.*, SUM(a.amount_centavos) OVER (PARTITION BY a.account_id ORDER BY a.due_date, a.seq) AS cum
  FROM active a WHERE a.amount_centavos > 0
),
applied AS (
  SELECT d.*,
    LEAST(d.amount_centavos, GREATEST(0, COALESCE(c.total, 0) - (d.cum - d.amount_centavos)))::bigint AS paid_centavos
  FROM debits d LEFT JOIN credits c USING (account_id)
)
SELECT id AS entry_id, seq, account_id, driver_id, entry_type, business_date, due_date, vehicle_id, plan_id,
  amount_centavos, paid_centavos, (amount_centavos - paid_centavos)::bigint AS outstanding_centavos,
  CASE WHEN paid_centavos = amount_centavos THEN 'paid'
       WHEN paid_centavos > 0 THEN 'partial'
       ELSE 'unpaid' END AS status
FROM applied;
--> statement-breakpoint

CREATE VIEW public.v_account_balances WITH (security_invoker = true) AS
SELECT a.id AS account_id, a.driver_id, a.kind, a.closed_on,
  COALESCE(SUM(e.amount_centavos), 0)::bigint AS balance_centavos
FROM public.driver_accounts a
LEFT JOIN public.ledger_entries e ON e.account_id = a.id
GROUP BY a.id;
--> statement-breakpoint

-- Cash received by collectors that has not yet been remitted to the office.
CREATE VIEW public.v_unremitted_cash WITH (security_invoker = true) AS
SELECT p.* FROM public.payments p
WHERE p.method = 'cash'
  AND NOT EXISTS (SELECT 1 FROM public.remittance_payments rp WHERE rp.payment_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM public.payment_voids v WHERE v.payment_id = p.id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.drivers, public.vehicles, public.franchises, public.vehicle_assignments, public.holidays,
  public.driver_accounts, public.boundary_plans, public.ledger_entries, public.payments, public.payment_lines,
  public.payment_voids, public.remittances, public.remittance_payments, public.charge_runs,
  public.v_charge_status, public.v_account_balances, public.v_unremitted_cash FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.drivers, public.vehicles, public.franchises, public.vehicle_assignments TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.holidays TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.driver_accounts, public.ledger_entries, public.payments, public.payment_lines,
  public.payment_voids, public.remittances, public.remittance_payments TO authenticated;
--> statement-breakpoint
GRANT UPDATE (closed_on) ON public.driver_accounts TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.boundary_plans TO authenticated;
--> statement-breakpoint
GRANT UPDATE (effective_to, notes) ON public.boundary_plans TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.charge_runs, public.v_charge_status, public.v_account_balances, public.v_unremitted_cash TO authenticated;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.ledger_entries_seq_seq, public.payment_receipt_seq TO authenticated;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row Level Security
--   A = owner_admin, F = finance, O = operations. Drivers read only their own rows.
-- ---------------------------------------------------------------------------
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.franchises ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vehicle_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.driver_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.boundary_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_voids ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.remittances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.remittance_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.charge_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- drivers: staff read (sales need it for CRM conversion later), A/F/O write, driver reads self.
CREATE POLICY drivers_select ON public.drivers FOR SELECT TO authenticated
  USING (app.is_staff() OR id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY drivers_insert ON public.drivers FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY drivers_update ON public.drivers FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'))
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint

-- fleet tables
CREATE POLICY vehicles_select ON public.vehicles FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY vehicles_write ON public.vehicles FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint
CREATE POLICY vehicles_update ON public.vehicles FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'operations')) WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint
CREATE POLICY franchises_select ON public.franchises FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations', 'sales'));
--> statement-breakpoint
CREATE POLICY franchises_insert ON public.franchises FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint
CREATE POLICY franchises_update ON public.franchises FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'operations')) WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint
CREATE POLICY assignments_select ON public.vehicle_assignments FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY assignments_insert ON public.vehicle_assignments FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint
CREATE POLICY assignments_update ON public.vehicle_assignments FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'operations')) WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint
CREATE POLICY holidays_select ON public.holidays FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY holidays_insert ON public.holidays FOR INSERT TO authenticated WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY holidays_delete ON public.holidays FOR DELETE TO authenticated USING (app.has_role('owner_admin'));
--> statement-breakpoint

-- accounts & plans
CREATE POLICY accounts_select ON public.driver_accounts FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY accounts_insert ON public.driver_accounts FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY accounts_update ON public.driver_accounts FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance')) WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY plans_select ON public.boundary_plans FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY plans_insert ON public.boundary_plans FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY plans_update ON public.boundary_plans FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'))
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint

-- ledger: scheduled charges are system-only; operations may post payments and driver costs/deposits;
-- adjustments, reversals and opening balances are owner_admin/finance only.
CREATE POLICY ledger_select ON public.ledger_entries FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY ledger_insert ON public.ledger_entries FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      (entry_type IN ('payment', 'cost_charge', 'deposit_charge')
        AND app.has_any_role('owner_admin', 'finance', 'operations'))
      OR (entry_type IN ('adjustment', 'reversal', 'opening_balance', 'bonus_credit')
        AND app.has_any_role('owner_admin', 'finance'))
    )
  );
--> statement-breakpoint

-- payments
CREATE POLICY payments_select ON public.payments FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY payments_insert ON public.payments FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY payment_lines_select ON public.payment_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_id));
--> statement-breakpoint
CREATE POLICY payment_lines_insert ON public.payment_lines FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY payment_voids_select ON public.payment_voids FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_id));
--> statement-breakpoint
CREATE POLICY payment_voids_insert ON public.payment_voids FOR INSERT TO authenticated
  WITH CHECK (voided_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- remittances: finance/admin receive cash; collectors see their own.
CREATE POLICY remittances_select ON public.remittances FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance') OR collector_id = auth.uid());
--> statement-breakpoint
CREATE POLICY remittances_insert ON public.remittances FOR INSERT TO authenticated
  WITH CHECK (received_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY remittance_payments_select ON public.remittance_payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.remittances r WHERE r.id = remittance_id));
--> statement-breakpoint
CREATE POLICY remittance_payments_insert ON public.remittance_payments FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

CREATE POLICY charge_runs_select ON public.charge_runs FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint

-- Drivers can see their own documents (licence, IDs, receipts).
CREATE POLICY documents_select_own_driver ON public.documents FOR SELECT TO authenticated
  USING (owner_type = 'driver' AND owner_id = app.current_driver_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Settings: owner confirmed the delinquency flag is "3 missed amortizations".
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0004_money_engine_security', true);
--> statement-breakpoint
DELETE FROM public.app_settings WHERE key = 'collections.delinquency_flag_months';
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('collections.delinquency_missed_amortizations', '3',
   'Flag a driver when this many monthly amortizations are past due and not fully paid (owner, 2026-09-27).'),
  ('collections.charge_catch_up_max_days', '31',
   'Maximum number of past days the daily charge job will back-fill in one run (safety limit).')
ON CONFLICT (key) DO NOTHING;

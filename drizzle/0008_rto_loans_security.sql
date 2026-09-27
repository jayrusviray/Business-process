-- ============================================================================
-- Phase 4: RTO contracts, vehicle loans — integrity, audit, RLS, settings.
-- ============================================================================

-- One active contract per vehicle and per driver.
CREATE UNIQUE INDEX rto_one_active_per_vehicle ON public.rto_contracts (vehicle_id) WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX rto_one_active_per_driver ON public.rto_contracts (driver_id) WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX loans_one_active_per_vehicle ON public.vehicle_loans (vehicle_id) WHERE status = 'active';
--> statement-breakpoint

-- The contract's account must be the driver's amortization account for this contract.
CREATE OR REPLACE FUNCTION app.check_rto_contract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.driver_accounts a
    WHERE a.id = NEW.account_id AND a.driver_id = NEW.driver_id AND a.kind = 'amortization' AND a.contract_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'RTO contract must use the driver''s amortization account created for it';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_contract BEFORE INSERT ON public.rto_contracts
  FOR EACH ROW EXECUTE FUNCTION app.check_rto_contract();
--> statement-breakpoint

-- Terms are immutable; only closing (once, from active) and notes may change.
CREATE OR REPLACE FUNCTION app.guard_rto_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'closed_on' - 'close_reason' - 'notes' - 'updated_at' - 'updated_by')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'closed_on' - 'close_reason' - 'notes' - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'RTO contract terms cannot be changed; terminate and create a new contract'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'a closed contract cannot be reopened' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.rto_contracts FOR EACH ROW EXECUTE FUNCTION app.guard_rto_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_loan_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'notes' - 'updated_at' - 'updated_by')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'notes' - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'loan terms cannot be changed; mark it restructured and create a new loan'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.vehicle_loans FOR EACH ROW EXECUTE FUNCTION app.guard_loan_update();
--> statement-breakpoint

-- A loan payment correction must exactly reverse a payment of the same loan.
CREATE OR REPLACE FUNCTION app.check_loan_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_orig public.loan_payments%ROWTYPE;
BEGIN
  IF NEW.reverses_payment_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.loan_payments WHERE id = NEW.reverses_payment_id;
    IF NOT FOUND OR v_orig.loan_id <> NEW.loan_id OR v_orig.amount_centavos <> -NEW.amount_centavos
       OR v_orig.reverses_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'a loan payment correction must exactly reverse a payment of the same loan';
    END IF;
  END IF;
  IF NEW.created_by IS NULL THEN NEW.created_by := app.current_actor(); END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_payment BEFORE INSERT ON public.loan_payments FOR EACH ROW EXECUTE FUNCTION app.check_loan_payment();
--> statement-breakpoint

CREATE TRIGGER no_delete BEFORE DELETE ON public.rto_contracts FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.vehicle_loans FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.loan_schedule_lines FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.loan_payments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.rto_contracts FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.vehicle_loans FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.rto_contracts FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_loans FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.loan_payments FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.rto_contracts, public.vehicle_loans, public.loan_schedule_lines, public.loan_payments FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.rto_contracts, public.vehicle_loans, public.loan_schedule_lines, public.loan_payments TO authenticated;
--> statement-breakpoint
GRANT UPDATE (status, closed_on, close_reason, notes) ON public.rto_contracts TO authenticated;
--> statement-breakpoint
GRANT UPDATE (status, notes) ON public.vehicle_loans TO authenticated;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.rto_contract_seq TO authenticated;
--> statement-breakpoint
ALTER TABLE public.rto_contracts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vehicle_loans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loan_schedule_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loan_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY rto_select ON public.rto_contracts FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY rto_insert ON public.rto_contracts FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY rto_update ON public.rto_contracts FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance')) WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- Vehicle loans are office finance: owner_admin + finance only.
CREATE POLICY loans_select ON public.vehicle_loans FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY loans_insert ON public.vehicle_loans FOR INSERT TO authenticated WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY loans_update ON public.vehicle_loans FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance')) WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY loan_lines_select ON public.loan_schedule_lines FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY loan_lines_insert ON public.loan_schedule_lines FOR INSERT TO authenticated WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY loan_payments_select ON public.loan_payments FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY loan_payments_insert ON public.loan_payments FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- Finance closes RTO contracts, which marks the vehicle as transferred.
CREATE POLICY vehicles_update_finance ON public.vehicles FOR UPDATE TO authenticated
  USING (app.has_role('finance')) WITH CHECK (app.has_role('finance'));
--> statement-breakpoint

-- Finance/admin may post amortization charges (contract set-up catch-up and the
-- cashout payoff). The daily job posts the regular monthly installments.
CREATE POLICY ledger_insert_amortization ON public.ledger_entries FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND entry_type = 'amortization_charge' AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0008_rto_loans_security', true);
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('rto.default_term_months', '60', 'Default RTO / boundary-hulog contract term (owner: 5 years).'),
  ('rto.cashout_requires_clear_balances', 'true',
   'Vehicle ownership is transferred on cashout/completion only if the driver''s boundary and costs balances are also fully paid. TO CONFIRM with owner.'),
  ('loans.due_alert_days', '7', 'Show vehicle loan dues this many days before the due date.')
ON CONFLICT (key) DO NOTHING;

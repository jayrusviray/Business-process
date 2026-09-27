-- ============================================================================
-- Phase 6: expenses, payroll, cash advances, commissions, investors.
-- Integrity guards, audit, RLS, seeds. Office data is owner_admin + finance only,
-- except: staff see their own finalized payslips; investors see their own payouts.
-- ============================================================================

ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_investor_id_fk FOREIGN KEY (investor_id) REFERENCES public.investors(id);
--> statement-breakpoint
ALTER TABLE public.expenses ADD CONSTRAINT expenses_employee_id_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Generic guard: a row may only be voided (once, with a reason); nothing else changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_void_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'already void' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason')
     OR NEW.voided_at IS NULL OR coalesce(NEW.void_reason, '') = '' THEN
    RAISE EXCEPTION 'this record can only be voided (with a reason); post a new one instead of editing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.voided_by := COALESCE(NEW.voided_by, app.current_actor());
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.cash_advances FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.commissions_received FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint

-- Payroll lines can only be written while their period is a draft.
CREATE OR REPLACE FUNCTION app.guard_payroll_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status public.payroll_status;
BEGIN
  SELECT status INTO v_status FROM public.payroll_periods WHERE id = COALESCE(NEW.period_id, OLD.period_id);
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'this payroll period is %; post corrections in the next period', v_status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_write BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_lines FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_line();
--> statement-breakpoint

-- Periods move forward only (draft → finalized → paid); dates never change.
CREATE OR REPLACE FUNCTION app.guard_payroll_period() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end OR NEW.half <> OLD.half THEN
    RAISE EXCEPTION 'payroll period dates cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'draft' AND NEW.status = 'finalized') OR (OLD.status = 'finalized' AND NEW.status = 'paid')) THEN
    RAISE EXCEPTION 'payroll can only move draft → finalized → paid' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'draft' AND NEW.pay_date <> OLD.pay_date THEN
    RAISE EXCEPTION 'the pay date of a finalized payroll cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.payroll_periods FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_period();
--> statement-breakpoint

-- A cash advance can't be settled beyond its amount, nor settled once void.
CREATE OR REPLACE FUNCTION app.check_ca_settlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_amount bigint;
  v_void timestamptz;
  v_settled bigint;
BEGIN
  SELECT amount_centavos, voided_at INTO v_amount, v_void FROM public.cash_advances WHERE id = NEW.cash_advance_id FOR UPDATE;
  IF v_void IS NOT NULL THEN
    RAISE EXCEPTION 'this cash advance is void';
  END IF;
  SELECT COALESCE(SUM(amount_centavos), 0) INTO v_settled FROM public.cash_advance_settlements WHERE cash_advance_id = NEW.cash_advance_id;
  IF v_settled + NEW.amount_centavos > v_amount THEN
    RAISE EXCEPTION 'settlements would exceed the cash advance';
  END IF;
  IF NEW.created_by IS NULL THEN NEW.created_by := app.current_actor(); END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_settlement BEFORE INSERT ON public.cash_advance_settlements FOR EACH ROW EXECUTE FUNCTION app.check_ca_settlement();
--> statement-breakpoint

-- Referral commissions: amounts are fixed at creation; status moves forward only.
CREATE OR REPLACE FUNCTION app.guard_referral_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.base_centavos <> OLD.base_centavos OR NEW.rate_bps <> OLD.rate_bps OR NEW.amount_centavos <> OLD.amount_centavos
     OR NEW.rto_contract_id <> OLD.rto_contract_id OR NEW.payable_on <> OLD.payable_on THEN
    RAISE EXCEPTION 'commission amounts cannot change; void it and create a new one' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'pending' AND NEW.status IN ('approved', 'void'))
      OR (OLD.status = 'approved' AND NEW.status IN ('paid', 'void'))) THEN
    RAISE EXCEPTION 'commission status cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'paid' AND NEW.paid_on IS NULL THEN RAISE EXCEPTION 'paid commissions need a paid date'; END IF;
  IF NEW.status = 'void' AND coalesce(NEW.void_reason, '') = '' THEN RAISE EXCEPTION 'a void needs a reason'; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.referral_commissions FOR EACH ROW EXECUTE FUNCTION app.guard_referral_update();
--> statement-breakpoint

-- Investor payouts: drafts may be recalculated or removed; paid rows are locked.
CREATE OR REPLACE FUNCTION app.guard_investor_payout() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status = 'paid' THEN
    RAISE EXCEPTION 'this investor payout is already paid' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'paid' AND NEW.paid_on IS NULL THEN
    RAISE EXCEPTION 'a paid payout needs a paid date';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_write BEFORE UPDATE OR DELETE ON public.investor_payouts FOR EACH ROW EXECUTE FUNCTION app.guard_investor_payout();
--> statement-breakpoint

CREATE TRIGGER no_delete BEFORE DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.cash_advances FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.commissions_received FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.referral_commissions FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.payroll_periods FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.employees FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.cash_advance_settlements FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.thirteenth_month_payouts FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Stamps + audit
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.expenses FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.payroll_periods FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.payroll_lines FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.cash_advances FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.thirteenth_month_payouts FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.referral_commissions FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.commissions_received FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.investors FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.investor_payouts FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.expense_categories FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.budgets FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('category_id', 'month');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.employees FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.payroll_periods FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.payroll_lines FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.cash_advances FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.cash_advance_settlements FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.thirteenth_month_payouts FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.referral_commissions FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.commissions_received FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.investors FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.investor_payouts FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Helpers for self-access
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_investor_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id FROM public.investors i JOIN public.profiles p ON p.id = i.profile_id
  WHERE i.profile_id = auth.uid() AND p.status = 'active'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_employee_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id FROM public.employees e JOIN public.profiles p ON p.id = e.profile_id
  WHERE e.profile_id = auth.uid() AND p.status = 'active'
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_investor_id(), app.current_employee_id() TO authenticated, service_role;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.expense_categories, public.recurring_expenses, public.expenses, public.budgets, public.employees,
  public.payroll_periods, public.payroll_lines, public.cash_advances, public.cash_advance_settlements,
  public.thirteenth_month_payouts, public.referral_commissions, public.commissions_received, public.investors,
  public.investor_payouts FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.expense_categories, public.recurring_expenses, public.budgets, public.employees,
  public.payroll_periods, public.referral_commissions, public.investors TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_lines, public.investor_payouts TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.expenses, public.cash_advances, public.cash_advance_settlements, public.thirteenth_month_payouts,
  public.commissions_received TO authenticated;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON public.expenses, public.cash_advances, public.commissions_received TO authenticated;
--> statement-breakpoint
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_advances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_advance_settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.thirteenth_month_payouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.referral_commissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.commissions_received ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.investors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.investor_payouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  -- Owner/admin + finance manage all office tables.
  FOREACH t IN ARRAY ARRAY['expense_categories', 'recurring_expenses', 'expenses', 'budgets', 'employees', 'payroll_periods',
    'payroll_lines', 'cash_advances', 'cash_advance_settlements', 'thirteenth_month_payouts', 'referral_commissions',
    'commissions_received', 'investors', 'investor_payouts'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (app.has_any_role(''owner_admin'', ''finance''))
      WITH CHECK (app.has_any_role(''owner_admin'', ''finance''))', t || '_finance_all', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Staff see their own finalized/paid payslips.
CREATE POLICY payroll_lines_own ON public.payroll_lines FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id()
    AND EXISTS (SELECT 1 FROM public.payroll_periods p WHERE p.id = period_id AND p.status <> 'draft'));
--> statement-breakpoint
CREATE POLICY payroll_periods_own ON public.payroll_periods FOR SELECT TO authenticated
  USING (status <> 'draft' AND app.current_employee_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY employees_own ON public.employees FOR SELECT TO authenticated USING (id = app.current_employee_id());
--> statement-breakpoint

-- Investors see themselves, their vehicles and their payouts.
CREATE POLICY investors_own ON public.investors FOR SELECT TO authenticated USING (id = app.current_investor_id());
--> statement-breakpoint
CREATE POLICY investor_payouts_own ON public.investor_payouts FOR SELECT TO authenticated USING (investor_id = app.current_investor_id());
--> statement-breakpoint
CREATE POLICY vehicles_select_own_investor ON public.vehicles FOR SELECT TO authenticated USING (investor_id = app.current_investor_id());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0012_office_security_seed', true);
--> statement-breakpoint
INSERT INTO public.expense_categories (name, sort) VALUES
  ('Office rent', 10), ('Internet', 20), ('Salaries', 30), ('Cellphone service units', 40), ('Utilities', 50),
  ('Travel & meetings', 60), ('Vehicle maintenance', 70), ('Government fees', 80), ('Others', 999)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('payroll.working_days_per_year', '261', 'Monthly salary → daily rate divisor (daily = monthly × 12 ÷ this). Labor Code default 261.'),
  ('payroll.hours_per_day', '8', 'Hours in a working day (hourly rate = daily ÷ this).'),
  ('payroll.premium_rates', '{"overtime_bps":12500,"rest_or_special_day_bps":13000,"regular_holiday_bps":20000,"night_diff_bps":1000}',
   'Labor Code defaults: overtime 125%, rest day / special day 130%, regular holiday 200%, night differential 10%.'),
  ('payroll.pay_delay_days', '0', 'Pay date = cut-off end + this many days (cut-offs are 1–15 and 16–end of month).'),
  ('payroll.ca_deduct_after_days', '7', 'Cash advances still unliquidated after this many days are proposed as a salary deduction (owner rule).'),
  ('payroll.thirteenth_month_tax_exempt_centavos', '9000000', '13th month and other benefits are tax-exempt up to this amount per year (₱90,000).'),
  ('commissions.referral_rate_bps', '1000', 'Referral commission as a % of the referred driver''s down payment (owner: 10%).'),
  ('commissions.referral_wait_months', '1', 'Referral commission becomes payable this many months after the contract start (owner: 1).'),
  ('investors.boundary_days', '22', 'Investor share = this many days × the driver''s daily boundary − the driver''s monthly RTO amortization (owner).')
ON CONFLICT (key) DO NOTHING;

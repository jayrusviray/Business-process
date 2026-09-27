-- ============================================================================
-- Phase 3: quotas & bonuses security, driver portal access, regular holidays.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------------
-- A result can't change once a (non-void) bonus has been awarded for it.
CREATE OR REPLACE FUNCTION app.guard_quota_result_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bonus_awards b WHERE b.quota_result_id = OLD.id AND b.voided_at IS NULL) THEN
    RAISE EXCEPTION 'a bonus was already awarded for this result; void the bonus first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.rule_id <> OLD.rule_id OR NEW.driver_id <> OLD.driver_id OR NEW.period_start <> OLD.period_start THEN
    RAISE EXCEPTION 'only the value of a quota result can change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.quota_results
  FOR EACH ROW EXECUTE FUNCTION app.guard_quota_result_update();
--> statement-breakpoint

-- Awards are immutable except for a one-time void.
CREATE OR REPLACE FUNCTION app.guard_bonus_award_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bonus is already void' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason')
     OR NEW.voided_at IS NULL OR coalesce(NEW.void_reason, '') = '' THEN
    RAISE EXCEPTION 'a bonus award can only be voided (with a reason)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.bonus_awards
  FOR EACH ROW EXECUTE FUNCTION app.guard_bonus_award_update();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.bonus_awards FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.quota_rules FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- A bonus award must match its result's driver and must meet the rule threshold.
CREATE OR REPLACE FUNCTION app.check_bonus_award() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT r.driver_id = NEW.driver_id AND r.value >= q.threshold INTO v_ok
  FROM public.quota_results r JOIN public.quota_rules q ON q.id = r.rule_id
  WHERE r.id = NEW.quota_result_id;
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'bonus does not match a quota hit for this driver';
  END IF;
  IF NEW.created_by IS NULL THEN NEW.created_by := app.current_actor(); END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_award BEFORE INSERT ON public.bonus_awards
  FOR EACH ROW EXECUTE FUNCTION app.check_bonus_award();
--> statement-breakpoint

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.quota_rules FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.quota_results FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.quota_rules FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.quota_results FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.bonus_awards FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.quota_rules, public.quota_results, public.bonus_awards FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.quota_rules, public.quota_results TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.bonus_awards TO authenticated;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON public.bonus_awards TO authenticated;
--> statement-breakpoint
ALTER TABLE public.quota_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.quota_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.bonus_awards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Rules are visible to every signed-in user (drivers see their targets); A/F maintain them.
CREATE POLICY quota_rules_select ON public.quota_rules FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY quota_rules_insert ON public.quota_rules FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY quota_rules_update ON public.quota_rules FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance')) WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

CREATE POLICY quota_results_select ON public.quota_results FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY quota_results_insert ON public.quota_results FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY quota_results_update ON public.quota_results FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'))
  WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint

CREATE POLICY bonus_awards_select ON public.bonus_awards FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY bonus_awards_insert ON public.bonus_awards FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY bonus_awards_update ON public.bonus_awards FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance'))
  WITH CHECK (voided_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Driver portal
-- ---------------------------------------------------------------------------
-- Drivers can see the vehicles they drive or drove.
CREATE POLICY vehicles_select_own_driver ON public.vehicles FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.vehicle_assignments va
    WHERE va.vehicle_id = vehicles.id AND va.driver_id = app.current_driver_id()
  ));
--> statement-breakpoint

-- Operations/finance may grant ONLY the 'driver' role, and only to a login already
-- linked to a driver record (portal access). All other grants stay owner_admin-only.
CREATE POLICY user_roles_insert_driver_portal ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (
    role = 'driver'
    AND app.has_any_role('finance', 'operations')
    AND EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = user_id)
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0006_quotas_security_portal', true);
--> statement-breakpoint

-- Owner: 200 rides in a month. Bonus amount not yet given → inactive until an admin sets it.
INSERT INTO public.quota_rules (name, metric, period, threshold, bonus_centavos, active, notes)
SELECT 'Monthly ride quota', 'trips', 'monthly', 200, 0, false,
       'Owner rule: 200 rides in a month. Set the bonus amount, then activate.'
WHERE NOT EXISTS (SELECT 1 FROM public.quota_rules);
--> statement-breakpoint

-- Regular holidays only (owner, 2026-09-27). Fixed-date regular holidays plus
-- Holy Week and National Heroes Day. Eid'l Fitr / Eid'l Adha dates are proclaimed
-- each year: add them on the Holidays screen once announced.
INSERT INTO public.holidays (date, name) VALUES
  ('2026-11-30', 'Bonifacio Day'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-30', 'Rizal Day'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-03-25', 'Maundy Thursday'),
  ('2027-03-26', 'Good Friday'),
  ('2027-04-09', 'Araw ng Kagitingan'),
  ('2027-05-01', 'Labor Day'),
  ('2027-06-12', 'Independence Day'),
  ('2027-08-30', 'National Heroes Day'),
  ('2027-11-30', 'Bonifacio Day'),
  ('2027-12-25', 'Christmas Day'),
  ('2027-12-30', 'Rizal Day')
ON CONFLICT (date) DO NOTHING;

-- ============================================================================
-- M-C: documentation role, clients, applications (checklists, status history,
-- fees and payments), application commissions, vehicle compliance seeds.
--
-- The 'documentation' role was added to app_role in 0017. Migrations run in one
-- transaction and a new enum value can't be used before it is committed, so
-- role checks here compare roles as text (app.has_any_role_text).
-- ============================================================================

CREATE OR REPLACE FUNCTION app.has_any_role_text(VARIADIC roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role::text = ANY (roles)
      AND p.status = 'active'
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.has_any_role_text(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.has_any_role_text(text[]) TO authenticated, service_role;
--> statement-breakpoint
-- Documentation staff are staff (profiles, document uploads, staff directory…).
CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT app.has_any_role_text('owner_admin', 'finance', 'operations', 'sales', 'documentation')
$$;
--> statement-breakpoint

ALTER TABLE public.franchises ADD CONSTRAINT franchises_client_id_fk FOREIGN KEY (client_id) REFERENCES public.clients(id);
--> statement-breakpoint
CREATE INDEX franchises_client_idx ON public.franchises (client_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Applications: status bookkeeping and history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.check_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind public.application_status_kind;
BEGIN
  SELECT kind INTO v_kind FROM public.application_statuses WHERE key = NEW.status_key;
  IF v_kind = 'cancelled' AND coalesce(btrim(NEW.cancel_reason), '') = '' THEN
    RAISE EXCEPTION 'give a reason when an application is cancelled' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.status_key IS DISTINCT FROM OLD.status_key THEN
    NEW.status_changed_at := now();
    IF v_kind IN ('approved', 'completed') AND NEW.approved_at IS NULL THEN NEW.approved_at := now(); END IF;
    IF v_kind = 'completed' AND NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.app_no <> OLD.app_no OR NEW.source <> OLD.source) THEN
    RAISE EXCEPTION 'the application number and source cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_application BEFORE INSERT OR UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION app.check_application();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.log_application_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status_key IS DISTINCT FROM OLD.status_key THEN
    INSERT INTO public.application_status_history (application_id, from_key, to_key, note, changed_by)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status_key END, NEW.status_key,
      coalesce(current_setting('app.status_note', true), ''), app.current_actor());
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER log_status AFTER INSERT OR UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION app.log_application_status();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.applications FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.applications FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_update BEFORE UPDATE OR DELETE ON public.application_status_history FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Checklist: a new file clears an earlier verification.
CREATE OR REPLACE FUNCTION app.check_checklist_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.application_id <> OLD.application_id THEN
    RAISE EXCEPTION 'a checklist item cannot move to another application' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    NEW.submitted_at := CASE WHEN NEW.document_id IS NULL THEN NULL ELSE now() END;
    IF NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
      NEW.verified_at := NULL;
      NEW.verified_by := NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_item BEFORE UPDATE ON public.application_checklist_items FOR EACH ROW EXECUTE FUNCTION app.check_checklist_item();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.application_checklist_items FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_checklist_items FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.application_checklist_items FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Fees and payments: void only (money rules).
CREATE TRIGGER stamp BEFORE INSERT ON public.application_fees FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.application_fees FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.application_fees FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_fees FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.application_payments FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.application_payments FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.application_payments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_payments FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- Application commissions: amounts fixed at creation; pending → approved → paid, or void.
CREATE OR REPLACE FUNCTION app.guard_application_commission() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.base_centavos <> OLD.base_centavos OR NEW.rate_bps <> OLD.rate_bps OR NEW.amount_centavos <> OLD.amount_centavos
     OR NEW.application_id <> OLD.application_id OR NEW.mode <> OLD.mode THEN
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
CREATE TRIGGER guard_update BEFORE UPDATE ON public.application_commissions FOR EACH ROW EXECUTE FUNCTION app.guard_application_commission();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.application_commissions FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.application_commissions FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_commissions FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.application_commission_rules FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_commission_rules FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('type_key');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_types FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('key');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.application_statuses FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('key');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.checklist_templates FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.application_types FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.application_statuses FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.clients, public.application_types, public.application_statuses, public.checklist_templates,
  public.applications, public.application_checklist_items, public.application_status_history, public.application_fees,
  public.application_payments, public.application_commission_rules, public.application_commissions FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.clients, public.application_types, public.application_statuses, public.checklist_templates,
  public.applications, public.application_checklist_items, public.application_commission_rules, public.application_commissions TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.application_status_history TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.application_fees, public.application_payments TO authenticated;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON public.application_fees, public.application_payments TO authenticated;
--> statement-breakpoint
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_statuses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_checklist_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_status_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_fees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_commission_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.application_commissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Who works applications: owner/admin, operations, documentation and sales. Finance sees them (fees, cash in).
CREATE POLICY clients_select ON public.clients FOR SELECT TO authenticated
  USING (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation', 'finance'));
--> statement-breakpoint
CREATE POLICY clients_write ON public.clients FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation'));
--> statement-breakpoint
CREATE POLICY clients_update ON public.clients FOR UPDATE TO authenticated
  USING (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation'))
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation'));
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  -- Reference data: staff read; owner/admin maintain.
  FOREACH t IN ARRAY ARRAY['application_types', 'application_statuses', 'checklist_templates', 'application_commission_rules'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.is_staff())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (app.has_any_role_text(''owner_admin''))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (app.has_any_role_text(''owner_admin'')) WITH CHECK (app.has_any_role_text(''owner_admin''))', t || '_update', t);
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE POLICY applications_select ON public.applications FOR SELECT TO authenticated
  USING (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation', 'finance'));
--> statement-breakpoint
CREATE POLICY applications_insert ON public.applications FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation'));
--> statement-breakpoint
CREATE POLICY applications_update ON public.applications FOR UPDATE TO authenticated
  USING (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation'))
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation'));
--> statement-breakpoint

CREATE POLICY checklist_items_select ON public.application_checklist_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.applications a WHERE a.id = application_id));
--> statement-breakpoint
CREATE POLICY checklist_items_insert ON public.application_checklist_items FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation')
    AND EXISTS (SELECT 1 FROM public.applications a WHERE a.id = application_id));
--> statement-breakpoint
-- Uploading and verifying documents is the documentation team's job (plus owner/admin and operations).
CREATE POLICY checklist_items_update ON public.application_checklist_items FOR UPDATE TO authenticated
  USING (app.has_any_role_text('owner_admin', 'operations', 'documentation'))
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'documentation'));
--> statement-breakpoint
CREATE POLICY status_history_select ON public.application_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.applications a WHERE a.id = application_id));
--> statement-breakpoint

CREATE POLICY application_fees_select ON public.application_fees FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.applications a WHERE a.id = application_id));
--> statement-breakpoint
-- Sales quote the service fee when they convert a lead.
CREATE POLICY application_fees_insert ON public.application_fees FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role_text('owner_admin', 'operations', 'documentation', 'finance', 'sales'));
--> statement-breakpoint
CREATE POLICY application_fees_void ON public.application_fees FOR UPDATE TO authenticated
  USING (app.has_any_role_text('owner_admin', 'finance')) WITH CHECK (app.has_any_role_text('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY application_payments_select ON public.application_payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.applications a WHERE a.id = application_id));
--> statement-breakpoint
CREATE POLICY application_payments_insert ON public.application_payments FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role_text('owner_admin', 'operations', 'documentation', 'finance'));
--> statement-breakpoint
CREATE POLICY application_payments_void ON public.application_payments FOR UPDATE TO authenticated
  USING (app.has_any_role_text('owner_admin', 'finance')) WITH CHECK (app.has_any_role_text('owner_admin', 'finance'));
--> statement-breakpoint

-- Commissions are created by whoever approves the application (so they see them too); finance approves and pays them.
CREATE POLICY application_commissions_select ON public.application_commissions FOR SELECT TO authenticated
  USING (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation', 'finance'));
--> statement-breakpoint
CREATE POLICY application_commissions_insert ON public.application_commissions FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role_text('owner_admin', 'operations', 'sales', 'documentation', 'finance'));
--> statement-breakpoint
CREATE POLICY application_commissions_update ON public.application_commissions FOR UPDATE TO authenticated
  USING (app.has_any_role_text('owner_admin', 'finance')) WITH CHECK (app.has_any_role_text('owner_admin', 'finance'));
--> statement-breakpoint

-- Documentation staff see application and client documents (like sales).
CREATE POLICY documents_select_documentation ON public.documents FOR SELECT TO authenticated
  USING (owner_type IN ('application', 'client') AND app.has_any_role_text('documentation', 'sales'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0018_applications_security', true);
--> statement-breakpoint
INSERT INTO public.application_statuses (key, label, kind, sort) VALUES
  ('inquiry', 'Inquiry', 'open', 10),
  ('requirements_pending', 'Requirements pending', 'open', 20),
  ('documents_complete', 'Documents complete', 'open', 30),
  ('filed', 'Filed / submitted', 'open', 40),
  ('for_hearing', 'For hearing / evaluation', 'open', 50),
  ('approved', 'Approved / activated', 'approved', 60),
  ('completed', 'Released / completed', 'completed', 70),
  ('on_hold', 'On hold', 'on_hold', 80),
  ('cancelled', 'Cancelled', 'cancelled', 90)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.application_types (key, label, service_line, description, sort) VALUES
  ('ltfrb_pa_new', 'LTFRB Provisional Authority (PA) — new', 'franchise', 'New TNVS franchise application (PA).', 10),
  ('ltfrb_cpc_new', 'LTFRB CPC — new', 'franchise', 'Certificate of Public Convenience after the PA.', 20),
  ('ltfrb_cpc_renewal', 'LTFRB CPC — renewal', 'franchise', 'Renewal of an expiring CPC.', 30),
  ('ltfrb_extension', 'LTFRB PA/CPC — extension', 'franchise', 'Extension of validity.', 40),
  ('platform_activation', 'Platform activation / onboarding', 'activation', 'Activating a driver and vehicle on a ride-hailing platform (e.g. inDrive).', 50),
  ('vehicle_acquisition', 'Vehicle acquisition program', 'vehicle_program', 'A driver or operator applying to acquire a unit.', 60),
  ('driver_program', 'Driver program (boundary / rent-to-own)', 'vehicle_program', 'Applying to drive under the boundary or boundary-hulog program. Approved applicants become drivers.', 70)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Generic starting checklists: the owner/documentation team should replace them with the real requirements.
INSERT INTO public.checklist_templates (type_key, label, required, sort)
SELECT v.type_key, v.label, v.required, v.sort FROM (VALUES
  ('ltfrb_pa_new', 'Valid government ID of the operator', true, 10),
  ('ltfrb_pa_new', 'Vehicle OR/CR or sales invoice', true, 20),
  ('ltfrb_pa_new', 'TNC / platform accreditation', true, 30),
  ('ltfrb_pa_new', 'Proof of financial capacity', false, 40),
  ('ltfrb_cpc_new', 'Approved Provisional Authority (PA)', true, 10),
  ('ltfrb_cpc_new', 'Vehicle OR/CR', true, 20),
  ('ltfrb_cpc_new', 'Insurance policy (CTPL / passenger)', true, 30),
  ('ltfrb_cpc_renewal', 'Current CPC', true, 10),
  ('ltfrb_cpc_renewal', 'Vehicle OR/CR (current registration)', true, 20),
  ('ltfrb_cpc_renewal', 'Insurance policy (CTPL / passenger)', true, 30),
  ('ltfrb_extension', 'Current PA/CPC', true, 10),
  ('ltfrb_extension', 'Vehicle OR/CR', true, 20),
  ('platform_activation', 'Professional driver''s license', true, 10),
  ('platform_activation', 'NBI clearance', true, 20),
  ('platform_activation', 'Vehicle OR/CR', true, 30),
  ('platform_activation', 'Franchise (PA/CPC)', true, 40),
  ('vehicle_acquisition', 'Two valid government IDs', true, 10),
  ('vehicle_acquisition', 'Proof of billing (address)', true, 20),
  ('vehicle_acquisition', 'Proof of income', false, 30),
  ('driver_program', 'Professional driver''s license', true, 10),
  ('driver_program', 'Two valid government IDs', true, 20),
  ('driver_program', 'NBI or police clearance', true, 30),
  ('driver_program', 'Proof of billing (address)', true, 40)
) AS v(type_key, label, required, sort)
WHERE NOT EXISTS (SELECT 1 FROM public.checklist_templates);
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('alerts.document_expiry_warn_days', '60', 'Warn about OR/CR, insurance and franchise (PA/CPC) expiries within this many days (spec: 30/60).'),
  ('alerts.document_expiry_urgent_days', '30', 'Expiries within this many days are shown as urgent.')
ON CONFLICT (key) DO NOTHING;

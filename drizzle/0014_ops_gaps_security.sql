-- ============================================================================
-- M-A: payment proofs from the portal, daily collection close, vehicle
-- maintenance log, driver platform accounts. Guards, audit, RLS, settings.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Payment proofs
-- ---------------------------------------------------------------------------
-- On insert: the file must be the driver's own upload filed under this proof,
-- the proof starts pending, and a driver can't flood the queue.
CREATE OR REPLACE FUNCTION app.check_payment_proof_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_max int;
BEGIN
  IF NEW.status <> 'pending' OR NEW.decided_at IS NOT NULL OR NEW.payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'a payment proof must be submitted as pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = NEW.document_id AND d.owner_type = 'payment_proof' AND d.owner_id = NEW.id
      AND d.uploaded_by = NEW.submitted_by
  ) THEN
    RAISE EXCEPTION 'the proof file must be uploaded by the submitter for this proof';
  END IF;
  SELECT (value #>> '{}')::int INTO v_max FROM public.app_settings WHERE key = 'portal.max_pending_proofs';
  IF (SELECT count(*) FROM public.payment_proofs p WHERE p.driver_id = NEW.driver_id AND p.status = 'pending') >= COALESCE(v_max, 5) THEN
    RAISE EXCEPTION 'too many payment proofs are waiting for verification' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_insert BEFORE INSERT ON public.payment_proofs
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_proof_insert();
--> statement-breakpoint

-- One decision per proof. Approval must point at a payment for the same driver and amount.
CREATE OR REPLACE FUNCTION app.guard_payment_proof_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'this payment proof was already decided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'reject_reason' - 'payment_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'reject_reason' - 'payment_id') THEN
    RAISE EXCEPTION 'only the decision on a payment proof can change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.id = NEW.payment_id AND p.driver_id = NEW.driver_id AND p.amount_centavos = NEW.amount_centavos
  ) THEN
    RAISE EXCEPTION 'the approved payment must match the proof''s driver and amount';
  END IF;
  NEW.decided_by := COALESCE(NEW.decided_by, app.current_actor());
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.payment_proofs
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_proof_update();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.payment_proofs FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.payment_proofs FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Daily collection close (immutable snapshot)
-- ---------------------------------------------------------------------------
CREATE TRIGGER no_update BEFORE UPDATE OR DELETE ON public.collection_day_closes
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.collection_day_closes
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('business_date');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Vehicle maintenance log (void only)
-- ---------------------------------------------------------------------------
-- A linked driver charge must be a cost charge for the same driver and amount.
CREATE OR REPLACE FUNCTION app.check_vehicle_maintenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.ledger_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ledger_entries e
    WHERE e.id = NEW.ledger_entry_id AND e.entry_type = 'cost_charge'
      AND e.driver_id = NEW.driver_id AND e.amount_centavos = NEW.cost_centavos
  ) THEN
    RAISE EXCEPTION 'the driver charge must be a cost charge for this driver and amount';
  END IF;
  IF NEW.expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expenses x
    WHERE x.id = NEW.expense_id AND x.amount_centavos = NEW.cost_centavos AND x.vehicle_id = NEW.vehicle_id
  ) THEN
    RAISE EXCEPTION 'the expense must be for this vehicle and amount';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_insert BEFORE INSERT ON public.vehicle_maintenance
  FOR EACH ROW EXECUTE FUNCTION app.check_vehicle_maintenance();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.vehicle_maintenance FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.vehicle_maintenance FOR EACH ROW EXECUTE FUNCTION app.guard_void_only();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.vehicle_maintenance FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_maintenance FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Driver platform accounts (reference data, editable)
-- ---------------------------------------------------------------------------
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.driver_platform_accounts FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.driver_platform_accounts FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.payment_proofs, public.collection_day_closes, public.vehicle_maintenance,
  public.driver_platform_accounts FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.payment_proofs, public.collection_day_closes, public.vehicle_maintenance TO authenticated;
--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, reject_reason, payment_id) ON public.payment_proofs TO authenticated;
--> statement-breakpoint
GRANT UPDATE (voided_at, voided_by, void_reason) ON public.vehicle_maintenance TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_platform_accounts TO authenticated;
--> statement-breakpoint
ALTER TABLE public.payment_proofs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.collection_day_closes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vehicle_maintenance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.driver_platform_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Proofs: collections staff see all; a driver sees and submits only their own.
CREATE POLICY payment_proofs_select ON public.payment_proofs FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY payment_proofs_insert ON public.payment_proofs FOR INSERT TO authenticated
  WITH CHECK (driver_id = app.current_driver_id() AND submitted_by = auth.uid());
--> statement-breakpoint
CREATE POLICY payment_proofs_update ON public.payment_proofs FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance'))
  WITH CHECK (decided_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- A driver may upload (and later view) only their own payment proof files.
CREATE POLICY documents_insert_own_proof ON public.documents FOR INSERT TO authenticated
  WITH CHECK (owner_type = 'payment_proof' AND uploaded_by = auth.uid() AND app.current_driver_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY documents_select_own_proof ON public.documents FOR SELECT TO authenticated
  USING (owner_type = 'payment_proof' AND uploaded_by = auth.uid());
--> statement-breakpoint

CREATE POLICY collection_day_closes_select ON public.collection_day_closes FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY collection_day_closes_insert ON public.collection_day_closes FOR INSERT TO authenticated
  WITH CHECK (closed_by = auth.uid() AND app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

CREATE POLICY vehicle_maintenance_select ON public.vehicle_maintenance FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY vehicle_maintenance_insert ON public.vehicle_maintenance FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
-- Voiding reverses the driver charge, which only owner_admin/finance may post.
CREATE POLICY vehicle_maintenance_update ON public.vehicle_maintenance FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance'))
  WITH CHECK (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

CREATE POLICY driver_platform_accounts_select ON public.driver_platform_accounts FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations') OR driver_id = app.current_driver_id());
--> statement-breakpoint
CREATE POLICY driver_platform_accounts_write ON public.driver_platform_accounts FOR ALL TO authenticated
  USING (app.has_any_role('owner_admin', 'operations'))
  WITH CHECK (app.has_any_role('owner_admin', 'operations'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0014_ops_gaps_security', true);
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('portal.max_pending_proofs', '5',
   'A driver can have at most this many payment proofs waiting for verification.'),
  ('alerts.consecutive_unpaid_days', '3',
   'Flag a driver when this many boundary days in a row are unpaid (spec default; confirm with the owner).'),
  ('alerts.balance_threshold_centavos', '500000',
   'Flag a driver whose total balance is at or above this amount (₱5,000.00 placeholder; confirm with the owner).'),
  ('alerts.license_expiry_days', '30',
   'Flag drivers whose licence expires within this many days.'),
  ('reminders.quiet_hours', '{"start":"21:00","end":"07:00"}',
   'No reminders are sent between these Manila times (spec: never between 9 PM and 7 AM).')
ON CONFLICT (key) DO NOTHING;

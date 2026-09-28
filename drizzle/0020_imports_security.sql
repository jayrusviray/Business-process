-- ============================================================================
-- M-E: spreadsheet import (Phase 9). Import batches and reference-only legacy
-- payments. Both are append-only. Imports are owner_admin only; legacy payments
-- are readable by the staff who see driver ledgers (owner_admin, finance,
-- operations). Legacy payments never touch the ledger: the driver's net history
-- comes in as opening balances (entry_type 'opening_balance', idempotency key
-- 'import:{batch}:{line}').
-- Role checks compare roles as text (app.has_any_role_text, migration 0018).
-- ============================================================================

-- A legacy payment must belong to a legacy-payments batch.
CREATE OR REPLACE FUNCTION app.check_legacy_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = NEW.batch_id AND b.kind = 'legacy_payments') THEN
    RAISE EXCEPTION 'legacy payments must belong to a legacy_payments import batch';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_payment BEFORE INSERT ON public.legacy_payments FOR EACH ROW EXECUTE FUNCTION app.check_legacy_payment();
--> statement-breakpoint

CREATE TRIGGER stamp BEFORE INSERT ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.legacy_payments FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.import_batches FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.legacy_payments FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.legacy_payments FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.import_batches FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.legacy_payments FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.import_batches, public.legacy_payments FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.import_batches, public.legacy_payments TO authenticated;
--> statement-breakpoint
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.legacy_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY import_batches_select ON public.import_batches FOR SELECT TO authenticated
  USING (app.has_any_role_text('owner_admin'));
--> statement-breakpoint
CREATE POLICY import_batches_insert ON public.import_batches FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role_text('owner_admin'));
--> statement-breakpoint

CREATE POLICY legacy_payments_select ON public.legacy_payments FOR SELECT TO authenticated
  USING (app.has_any_role_text('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY legacy_payments_insert ON public.legacy_payments FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role_text('owner_admin'));

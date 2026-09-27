-- ============================================================================
-- Phase 5: reminders (manual send). Integrity, audit, RLS, default templates/rules.
-- ============================================================================

-- A message's text and recipient never change; only its outcome is recorded, once.
CREATE OR REPLACE FUNCTION app.guard_message_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'this message was already handled' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'handled_at' - 'handled_by' - 'provider_message_id' - 'error' - 'cost_centavos')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'handled_at' - 'handled_by' - 'provider_message_id' - 'error' - 'cost_centavos') THEN
    RAISE EXCEPTION 'only the outcome of a message can be recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> 'pending' AND NEW.handled_at IS NULL THEN
    NEW.handled_at := now();
    NEW.handled_by := app.current_actor();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION app.guard_message_update();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.message_opt_outs FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE UPDATE ON public.message_templates FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE UPDATE ON public.reminder_rules FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.message_templates FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.reminder_rules FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('trigger');
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.message_opt_outs FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('phone', 'channel');
--> statement-breakpoint
CREATE TRIGGER audit AFTER UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS (drivers and investors see none of this)
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.message_templates, public.reminder_rules, public.messages, public.message_opt_outs FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.message_templates, public.reminder_rules TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.messages TO authenticated;
--> statement-breakpoint
GRANT UPDATE (status, handled_at, handled_by, provider_message_id, error, cost_centavos) ON public.messages TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.message_opt_outs TO authenticated;
--> statement-breakpoint
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reminder_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.message_opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY templates_select ON public.message_templates FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY templates_update ON public.message_templates FOR UPDATE TO authenticated
  USING (app.has_role('owner_admin')) WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY rules_select ON public.reminder_rules FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY rules_update ON public.reminder_rules FOR UPDATE TO authenticated
  USING (app.has_role('owner_admin')) WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY messages_select ON public.messages FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY messages_insert ON public.messages FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY messages_update ON public.messages FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'finance', 'operations')) WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY opt_outs_select ON public.message_opt_outs FOR SELECT TO authenticated USING (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY opt_outs_insert ON public.message_opt_outs FOR INSERT TO authenticated WITH CHECK (app.has_any_role('owner_admin', 'finance', 'operations'));
--> statement-breakpoint
CREATE POLICY opt_outs_delete ON public.message_opt_outs FOR DELETE TO authenticated USING (app.has_role('owner_admin'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Defaults. Amounts render as "P700.00": the peso sign isn't in the basic SMS
-- character set and would cut each SMS from 160 to 70 characters.
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0010_reminders_security_seed', true);
--> statement-breakpoint
INSERT INTO public.message_templates (key, language, body) VALUES
  ('balance_weekly', 'en', 'Hi {{name}}, this is TransRev. Your current balance is {{balance}}. Please settle it at your earliest convenience. Thank you!'),
  ('balance_weekly', 'taglish', 'Hi {{name}}, TransRev po ito. Ang current balance mo ay {{balance}}. Paki-settle po agad. Salamat!'),
  ('missed_boundary', 'en', 'Hi {{name}}, your boundary of {{amount}} for {{date}} is not yet fully paid. Total balance: {{balance}}. - TransRev'),
  ('missed_boundary', 'taglish', 'Hi {{name}}, hindi pa fully paid ang boundary mo na {{amount}} para sa {{date}}. Total balance: {{balance}}. - TransRev'),
  ('amortization_upcoming', 'en', 'Hi {{name}}, reminder: your RTO amortization of {{amount}} ({{contract_no}}) is due on {{due_date}}. - TransRev'),
  ('amortization_upcoming', 'taglish', 'Hi {{name}}, paalala: ang RTO amortization mo na {{amount}} ({{contract_no}}) ay due sa {{due_date}}. - TransRev'),
  ('amortization_missed', 'en', 'Hi {{name}}, your RTO amortization of {{amount}} due {{due_date}} is unpaid. Missed amortizations: {{missed}}. Please pay as soon as possible. - TransRev'),
  ('amortization_missed', 'taglish', 'Hi {{name}}, hindi pa bayad ang RTO amortization mo na {{amount}} (due {{due_date}}). Missed amortizations: {{missed}}. Paki-bayaran po agad. - TransRev'),
  ('rto_milestone', 'en', 'Congratulations {{name}}! You have now paid {{percent}}% of your vehicle ({{contract_no}}). Keep it up! - TransRev'),
  ('rto_milestone', 'taglish', 'Congrats {{name}}! Bayad mo na ang {{percent}}% ng sasakyan mo ({{contract_no}}). Tuloy-tuloy lang! - TransRev'),
  ('license_expiry', 'en', 'Hi {{name}}, your driver''s license expires on {{due_date}} ({{days}} days). Please renew it and send us a copy. - TransRev'),
  ('license_expiry', 'taglish', 'Hi {{name}}, mag-e-expire ang driver''s license mo sa {{due_date}} ({{days}} days na lang). Paki-renew at padalhan kami ng kopya. - TransRev')
ON CONFLICT (key, language) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.reminder_rules (trigger, active, weekday, offset_days, min_amount_centavos, description) VALUES
  ('balance_weekly', true, 1, NULL, 100, 'Every Monday morning to drivers with a balance.'),
  ('missed_boundary', true, NULL, 1, 1, 'The morning after a boundary day that was not fully paid.'),
  ('amortization_upcoming', true, NULL, 3, 0, 'Days before an RTO installment is due.'),
  ('amortization_missed', true, NULL, 1, 0, 'Days after an RTO installment due date if it is still unpaid.'),
  ('rto_milestone', true, NULL, NULL, 0, 'When a driver passes 25%, 50%, 75% and 100% of their RTO contract.'),
  ('license_expiry', true, NULL, 30, 0, 'Days before the driver''s license expires.')
ON CONFLICT (trigger) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('messaging.mode', '"manual"', 'How reminders are sent. "manual" = staff send from their own phone (owner, 2026-09-27; no SMS gateway yet).')
ON CONFLICT (key) DO NOTHING;

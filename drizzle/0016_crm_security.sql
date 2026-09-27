-- ============================================================================
-- M-B: CRM (leads, stages, follow-ups), notifications, public website content.
-- Leads hold personal data (RA 10173): instead of the generic audit trigger,
-- stage and assignment changes are written to lead_activities, and an erasure
-- request deletes the lead with its history (logged in privacy_requests).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Leads: stamp, lost reason, automatic timeline entries
-- ---------------------------------------------------------------------------
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.check_lead() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind public.lead_stage_kind;
BEGIN
  SELECT kind INTO v_kind FROM public.lead_stages WHERE key = NEW.stage_key;
  IF v_kind = 'lost' AND coalesce(btrim(NEW.lost_reason), '') = '' THEN
    RAISE EXCEPTION 'give a reason when a lead is lost' USING ERRCODE = 'check_violation';
  END IF;
  IF v_kind = 'won' AND NEW.converted_at IS NULL THEN
    NEW.converted_at := now();
  ELSIF v_kind <> 'won' THEN
    NEW.converted_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER check_lead BEFORE INSERT OR UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION app.check_lead();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.log_lead_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.stage_key IS DISTINCT FROM OLD.stage_key THEN
    INSERT INTO public.lead_activities (lead_id, kind, body, meta, created_by)
    VALUES (NEW.id, 'stage_change',
      (SELECT label FROM public.lead_stages WHERE key = OLD.stage_key) || ' → ' ||
      (SELECT label FROM public.lead_stages WHERE key = NEW.stage_key) ||
      CASE WHEN NEW.lost_reason IS NOT NULL AND (SELECT kind FROM public.lead_stages WHERE key = NEW.stage_key) = 'lost'
        THEN ': ' || NEW.lost_reason ELSE '' END,
      jsonb_build_object('from', OLD.stage_key, 'to', NEW.stage_key), app.current_actor());
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO public.lead_activities (lead_id, kind, body, meta, created_by)
    VALUES (NEW.id, 'assignment',
      'Assigned to ' || COALESCE((SELECT COALESCE(NULLIF(full_name, ''), email) FROM public.profiles WHERE id = NEW.assigned_to), 'nobody'),
      jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to), app.current_actor());
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER log_change AFTER UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION app.log_lead_change();
--> statement-breakpoint

-- Timeline entries are append-only (they disappear only when the lead is erased).
CREATE TRIGGER stamp BEFORE INSERT ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER no_update BEFORE UPDATE ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- Follow-ups: only the completion can be recorded, once.
CREATE OR REPLACE FUNCTION app.guard_lead_followup_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.done_at IS NOT NULL THEN
    RAISE EXCEPTION 'this follow-up is already done' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'done_at' - 'done_by' - 'outcome') IS DISTINCT FROM (to_jsonb(OLD) - 'done_at' - 'done_by' - 'outcome')
     OR NEW.done_at IS NULL THEN
    RAISE EXCEPTION 'a follow-up can only be marked done' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.done_by := COALESCE(NEW.done_by, app.current_actor());
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT ON public.lead_followups FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER guard_update BEFORE UPDATE ON public.lead_followups FOR EACH ROW EXECUTE FUNCTION app.guard_lead_followup_update();
--> statement-breakpoint

CREATE TRIGGER no_update BEFORE UPDATE OR DELETE ON public.privacy_requests FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT ON public.privacy_requests FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint

CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.site_blocks FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.site_blocks FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.lead_stages FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('key');
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE ON public.lead_stages FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.lead_stages, public.leads, public.lead_activities, public.lead_followups, public.privacy_requests,
  public.notifications, public.public_submissions, public.site_blocks FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.lead_stages TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads, public.site_blocks TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.lead_activities, public.lead_followups, public.privacy_requests, public.notifications TO authenticated;
--> statement-breakpoint
GRANT UPDATE (done_at, done_by, outcome) ON public.lead_followups TO authenticated;
--> statement-breakpoint
GRANT UPDATE (read_at) ON public.notifications TO authenticated;
--> statement-breakpoint
ALTER TABLE public.lead_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.lead_activities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.lead_followups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.privacy_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- System only (public form rate limiting): RLS on, no grants, no policies.
ALTER TABLE public.public_submissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.site_blocks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY lead_stages_select ON public.lead_stages FOR SELECT TO authenticated USING (app.is_staff());
--> statement-breakpoint
CREATE POLICY lead_stages_insert ON public.lead_stages FOR INSERT TO authenticated WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY lead_stages_update ON public.lead_stages FOR UPDATE TO authenticated
  USING (app.has_role('owner_admin')) WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint

-- CRM: owner/admin, operations and sales agents work the leads; only owner/admin erases.
CREATE POLICY leads_select ON public.leads FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'operations', 'sales'));
--> statement-breakpoint
CREATE POLICY leads_insert ON public.leads FOR INSERT TO authenticated
  WITH CHECK (app.has_any_role('owner_admin', 'operations', 'sales'));
--> statement-breakpoint
CREATE POLICY leads_update ON public.leads FOR UPDATE TO authenticated
  USING (app.has_any_role('owner_admin', 'operations', 'sales'))
  WITH CHECK (app.has_any_role('owner_admin', 'operations', 'sales'));
--> statement-breakpoint
CREATE POLICY leads_delete ON public.leads FOR DELETE TO authenticated USING (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY lead_activities_select ON public.lead_activities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id));
--> statement-breakpoint
CREATE POLICY lead_activities_insert ON public.lead_activities FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id));
--> statement-breakpoint
CREATE POLICY lead_followups_select ON public.lead_followups FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id));
--> statement-breakpoint
CREATE POLICY lead_followups_insert ON public.lead_followups FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id));
--> statement-breakpoint
CREATE POLICY lead_followups_update ON public.lead_followups FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id))
  WITH CHECK (done_by = auth.uid());
--> statement-breakpoint

CREATE POLICY privacy_requests_select ON public.privacy_requests FOR SELECT TO authenticated USING (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY privacy_requests_insert ON public.privacy_requests FOR INSERT TO authenticated
  WITH CHECK (handled_by = auth.uid() AND app.has_role('owner_admin'));
--> statement-breakpoint

-- Notifications: each user reads and dismisses their own; any staff member may notify a colleague.
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY notifications_update ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY notifications_insert ON public.notifications FOR INSERT TO authenticated WITH CHECK (app.is_staff());
--> statement-breakpoint

-- Website content: public pages read it through the server; staff edit it.
CREATE POLICY site_blocks_select ON public.site_blocks FOR SELECT TO authenticated USING (app.is_staff());
--> statement-breakpoint
CREATE POLICY site_blocks_write ON public.site_blocks FOR ALL TO authenticated
  USING (app.has_any_role('owner_admin', 'sales')) WITH CHECK (app.has_any_role('owner_admin', 'sales'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
SELECT set_config('app.actor_label', 'migration:0016_crm_security', true);
--> statement-breakpoint
INSERT INTO public.lead_stages (key, label, kind, sort) VALUES
  ('new', 'New', 'open', 10),
  ('contacted', 'Contacted', 'open', 20),
  ('qualified', 'Qualified', 'open', 30),
  ('requirements_sent', 'Requirements sent', 'open', 40),
  ('converted', 'Converted', 'won', 90),
  ('lost', 'Lost', 'lost', 99)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.app_settings (key, value, description) VALUES
  ('crm.inquiry_rate_limit_per_hour', '5', 'Maximum website inquiries accepted per visitor (IP) per hour. Blocks spam.'),
  ('crm.meta_lead_ads_enabled', 'false', 'Accept Facebook Lead Ads through the Meta webhook (needs Meta app review and the META_* environment variables).'),
  ('site.facebook_url', '"https://www.facebook.com/profile.php?id=61561492040341"', 'TransRev Facebook page, linked from the website.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Default website copy. Placeholder until the owner provides final copy (docs/OPEN_QUESTIONS.md #12).
INSERT INTO public.site_blocks (section, title, body, service_line, sort)
SELECT * FROM (VALUES
  ('hero'::public.site_section, 'Hassle-free TNVS franchise, activation and fleet services',
   'LTFRB PA/CPC processing, ride-hailing activation and vehicle programs for TNVS drivers and operators — handled for you, from requirements to road.', NULL::public.service_line, 10),
  ('service', 'TNVS Franchise Documentation', 'We prepare and follow up your LTFRB Provisional Authority (PA) and Certificate of Public Convenience (CPC) — new applications, renewals and extensions.', 'franchise', 10),
  ('service', 'Platform Activation & Onboarding', 'Fleet partner for ride-hailing platforms like inDrive. We activate drivers and vehicles and walk you through onboarding.', 'activation', 20),
  ('service', 'Vehicle Programs', 'Drive under our boundary program, or own your unit through boundary-hulog (rent-to-own). Regional EV units available.', 'vehicle_program', 30),
  ('service', 'Fleet Management & Partnerships', 'For operators, dealers and investors: fleet management, vehicle acquisition and partnership programs.', 'fleet', 40),
  ('audience', 'TNVS drivers & operators', 'Get your franchise and activation sorted, or drive one of our units.', NULL, 10),
  ('audience', 'Ride-hailing & fleet platforms', 'A dependable fleet partner that activates and manages drivers and vehicles.', NULL, 20),
  ('audience', 'EV & automotive dealers', 'Move units through our vehicle programs and fleet partnerships.', NULL, 30),
  ('audience', 'Investors', 'Fund vehicles and earn from a managed fleet with monthly statements.', NULL, 40),
  ('step', 'Inquire', 'Send us a message here or on Facebook. We reply within the day.', NULL, 10),
  ('step', 'Submit requirements', 'We send you the checklist for your service. Submit online or at our office.', NULL, 20),
  ('step', 'We process', 'We file and follow up with LTFRB or the platform, and keep you updated.', NULL, 30),
  ('step', 'Get activated', 'Get your approval, activation or unit — and get on the road.', NULL, 40),
  ('requirement', 'LTFRB franchise (PA / CPC)', E'Valid government ID\nVehicle OR/CR (or sales invoice for new units)\nTNC/platform accreditation\nOther documents we will list after your inquiry', 'franchise', 10),
  ('requirement', 'Platform activation', E'Valid professional driver''s license\nNBI clearance\nVehicle OR/CR and franchise (PA/CPC)\nSmartphone with the platform app', 'activation', 20),
  ('requirement', 'Vehicle programs (boundary / rent-to-own)', E'Valid professional driver''s license\nTwo valid government IDs\nProof of billing (address)\nNBI or police clearance', 'vehicle_program', 30),
  ('program', 'Boundary', 'Drive a TransRev unit and pay a flat daily boundary. No boundary on regular holidays.', 'vehicle_program', 10),
  ('program', 'Boundary-hulog (rent-to-own)', 'Pay your daily boundary plus a fixed monthly amortization. When the contract is complete, the unit is yours.', 'vehicle_program', 20),
  ('faq', 'How long does LTFRB franchise processing take?', 'It depends on LTFRB schedules and your documents. We will give you an estimate once we review your requirements.', NULL, 10),
  ('faq', 'Can I apply if I don''t have a vehicle yet?', 'Yes. Ask about our boundary and rent-to-own vehicle programs.', NULL, 20),
  ('faq', 'Which platforms do you work with?', 'We are a fleet partner for ride-hailing platforms such as inDrive. Message us for the current list.', NULL, 30),
  ('faq', 'Where is your office?', 'Message us on Facebook or send an inquiry and we will share directions and office hours.', NULL, 40),
  ('school', 'TransRev driver school', 'Coming soon. Send us an inquiry and we will let you know when classes open.', 'school', 10),
  ('privacy', 'Privacy notice',
   E'TransRev collects the personal information you give us (name, mobile number, email, location and your message) only to answer your inquiry and to provide the services you ask for.\n\nWe keep it in a secured system that only authorized staff can access, and we do not sell or share it with third parties except when needed to process your application (for example with LTFRB or a ride-hailing platform) or when the law requires it.\n\nUnder the Data Privacy Act of 2012 (RA 10173) you may ask to access, correct or delete your information, or withdraw your consent, at any time. Contact us through the details below.',
   NULL, 10)
) AS v(section, title, body, service_line, sort)
WHERE NOT EXISTS (SELECT 1 FROM public.site_blocks);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Staff directory: active staff and their staff roles, visible to staff only.
-- (user_roles itself stays private: a user sees only their own roles.)
-- Roles are compared as text so later staff roles need no enum-typed literals here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.staff_directory() RETURNS TABLE (id uuid, name text, roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, COALESCE(NULLIF(p.full_name, ''), p.email, p.id::text) AS name,
    array_agg(ur.role::text ORDER BY ur.role::text) AS roles
  FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id
  WHERE p.status = 'active' AND ur.role::text NOT IN ('driver', 'investor') AND app.is_staff()
  GROUP BY p.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.staff_directory() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.staff_directory() TO authenticated, service_role;
--> statement-breakpoint

-- Open-lead load per active sales agent, for automatic assignment of new leads.
-- Usable by staff and by the system (public form, webhooks); empty for anyone else.
CREATE OR REPLACE FUNCTION app.lead_agent_load() RETURNS TABLE (id uuid, open_leads int, last_assigned_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id,
    (SELECT count(*)::int FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key
      WHERE l.assigned_to = p.id AND s.kind = 'open'),
    (SELECT max(l.created_at) FROM public.leads l WHERE l.assigned_to = p.id)
  FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id
  WHERE p.status = 'active' AND ur.role::text = 'sales' AND (auth.uid() IS NULL OR app.is_staff())
$$;
--> statement-breakpoint
-- Active users holding any of the given roles (to notify them). Same visibility rule.
CREATE OR REPLACE FUNCTION app.user_ids_with_roles(VARIADIC wanted text[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT p.id FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id
  WHERE p.status = 'active' AND ur.role::text = ANY (wanted) AND (auth.uid() IS NULL OR app.is_staff())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lead_agent_load(), app.user_ids_with_roles(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lead_agent_load(), app.user_ids_with_roles(text[]) TO authenticated, service_role;
--> statement-breakpoint

-- Erasure also removes notifications that point at the lead (they carry its name).
CREATE OR REPLACE FUNCTION app.scrub_lead_notifications() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.notifications WHERE link = '/app/crm/' || OLD.id::text;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER scrub_notifications AFTER DELETE ON public.leads FOR EACH ROW EXECUTE FUNCTION app.scrub_lead_notifications();

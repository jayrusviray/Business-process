-- ============================================================================
-- Security foundation: helper schema, role checks, audit trigger, append-only
-- guard, row stamping, new-user hook, and RLS policies for foundation tables.
--
-- Conventions (see CLAUDE.md):
--   * Every table in `public` has RLS enabled. No exceptions.
--   * `anon` gets nothing. Public forms go through server code.
--   * Financial/audit tables are append-only: guarded by app.forbid_mutation().
--   * Every audited table gets the app.audit_row_change() trigger.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO authenticated, service_role;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Actor resolution
--   Requests from users: request.jwt.claims.sub (set by withUserTx / PostgREST)
--   System jobs:          app.actor_id / app.actor_label (set by withSystemTx)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_actor() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(
    NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', ''),
    NULLIF(current_setting('app.actor_id', true), '')
  )::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.has_role(r public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role = r
      AND p.status = 'active'
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.has_any_role(VARIADIC roles public.app_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role = ANY (roles)
      AND p.status = 'active'
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT app.has_any_role('owner_admin', 'finance', 'operations', 'sales')
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.current_actor(), app.has_role(public.app_role),
  app.has_any_role(public.app_role[]), app.is_staff() TO authenticated, service_role;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Audit trigger. Usage:
--   CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON t
--     FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();            -- pk = id
--   ... EXECUTE FUNCTION app.audit_row_change('user_id', 'role');      -- composite pk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_before  jsonb;
  v_after   jsonb;
  v_row     jsonb;
  v_pk      text;
  v_changed text[];
  v_cols    text[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_before := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_after  := to_jsonb(NEW); END IF;
  v_row := COALESCE(v_after, v_before);

  IF TG_NARGS = 0 THEN
    v_cols := ARRAY['id'];
  ELSE
    v_cols := TG_ARGV;
  END IF;
  SELECT string_agg(v_row ->> c, ':' ORDER BY ord) INTO v_pk
  FROM unnest(v_cols) WITH ORDINALITY AS u(c, ord);

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(a.key ORDER BY a.key) INTO v_changed
    FROM jsonb_each(v_after) a
    WHERE a.value IS DISTINCT FROM v_before -> a.key
      AND a.key NOT IN ('updated_at', 'updated_by');
    IF v_changed IS NULL THEN
      RETURN NEW; -- no-op update, nothing to record
    END IF;
  END IF;

  INSERT INTO public.audit_log (table_name, row_pk, action, actor_id, actor_label, before, after, changed_fields)
  VALUES (
    TG_TABLE_NAME, COALESCE(v_pk, ''), TG_OP, app.current_actor(),
    NULLIF(current_setting('app.actor_label', true), ''),
    v_before, v_after, v_changed
  );
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint

-- Append-only guard for ledgers, audit and access logs.
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: table is append-only. Post a reversal/adjustment instead.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- Stamps created_by / updated_at / updated_by when those columns exist.
CREATE OR REPLACE FUNCTION app.stamp_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_actor uuid := app.current_actor();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (to_jsonb(NEW) ? 'created_by') AND (to_jsonb(NEW) ->> 'created_by') IS NULL THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('created_by', v_actor));
    END IF;
  ELSE
    NEW := jsonb_populate_record(NEW, jsonb_build_object('updated_at', now(), 'updated_by', v_actor));
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- New auth user → profile row (no roles; an admin grants roles explicitly).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.handle_new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, email, phone, full_name)
  VALUES (NEW.id, NEW.email, NEW.phone, COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.handle_new_auth_user();
--> statement-breakpoint

-- Only owner_admin may change a profile's status or email; users may edit their own name/phone.
CREATE OR REPLACE FUNCTION app.guard_profile_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.email IS DISTINCT FROM OLD.email OR NEW.id <> OLD.id)
     AND auth.uid() IS NOT NULL
     AND NOT app.has_role('owner_admin') THEN
    RAISE EXCEPTION 'only an owner/admin can change profile status or email'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Never allow the system to lose its last active owner_admin.
CREATE OR REPLACE FUNCTION app.guard_last_owner_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.role = 'owner_admin' AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'owner_admin' AND p.status = 'active' AND ur.user_id <> OLD.user_id
  ) THEN
    RAISE EXCEPTION 'cannot remove the last active owner_admin';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Triggers on foundation tables
-- ---------------------------------------------------------------------------
CREATE TRIGGER stamp BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.guard_profile_update();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('user_id', 'role');
--> statement-breakpoint
CREATE TRIGGER guard_last_admin BEFORE DELETE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION app.guard_last_owner_admin();
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('key');
--> statement-breakpoint
CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON public.gov_contribution_tables FOR EACH ROW EXECUTE FUNCTION app.stamp_row();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.gov_contribution_tables FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.document_access_log FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.document_access_log FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges: anon gets nothing; authenticated gets only what policies allow.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
--> statement-breakpoint
REVOKE ALL ON public.profiles, public.user_roles, public.audit_log, public.app_settings,
  public.gov_contribution_tables, public.documents, public.document_access_log FROM authenticated;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.user_roles TO authenticated;
--> statement-breakpoint
GRANT SELECT ON public.audit_log TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.app_settings TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.gov_contribution_tables TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.documents TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.document_access_log TO authenticated;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.document_access_log_id_seq TO authenticated;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.gov_contribution_tables ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.document_access_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- profiles
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR app.is_staff());
--> statement-breakpoint
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR app.has_role('owner_admin'))
  WITH CHECK (id = auth.uid() OR app.has_role('owner_admin'));
--> statement-breakpoint

-- user_roles
CREATE POLICY user_roles_select ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY user_roles_insert ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY user_roles_delete ON public.user_roles FOR DELETE TO authenticated
  USING (app.has_role('owner_admin'));
--> statement-breakpoint

-- audit_log: read-only for owner_admin and finance; writes only via trigger.
CREATE POLICY audit_log_select ON public.audit_log FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint

-- app_settings: staff read, owner_admin write.
CREATE POLICY app_settings_select ON public.app_settings FOR SELECT TO authenticated
  USING (app.is_staff());
--> statement-breakpoint
CREATE POLICY app_settings_insert ON public.app_settings FOR INSERT TO authenticated
  WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY app_settings_update ON public.app_settings FOR UPDATE TO authenticated
  USING (app.has_role('owner_admin')) WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint

-- gov_contribution_tables: owner_admin + finance read, owner_admin write.
CREATE POLICY gov_tables_select ON public.gov_contribution_tables FOR SELECT TO authenticated
  USING (app.has_any_role('owner_admin', 'finance'));
--> statement-breakpoint
CREATE POLICY gov_tables_insert ON public.gov_contribution_tables FOR INSERT TO authenticated
  WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint
CREATE POLICY gov_tables_update ON public.gov_contribution_tables FOR UPDATE TO authenticated
  USING (app.has_role('owner_admin')) WITH CHECK (app.has_role('owner_admin'));
--> statement-breakpoint

-- documents: ops/finance/admin see all; sales see application documents only.
-- (Driver self-access is added in Phase 2 once the drivers table exists.)
CREATE POLICY documents_select ON public.documents FOR SELECT TO authenticated
  USING (
    app.has_any_role('owner_admin', 'finance', 'operations')
    OR (owner_type = 'application' AND app.has_role('sales'))
  );
--> statement-breakpoint
CREATE POLICY documents_insert ON public.documents FOR INSERT TO authenticated
  WITH CHECK (app.is_staff() AND uploaded_by = auth.uid());
--> statement-breakpoint

-- document_access_log: a user logs their own access to a document they can see.
CREATE POLICY doc_access_insert ON public.document_access_log FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id)
  );
--> statement-breakpoint
CREATE POLICY doc_access_select ON public.document_access_log FOR SELECT TO authenticated
  USING (app.has_role('owner_admin'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Private storage bucket (Supabase only; skipped on plain Postgres test DBs).
-- No storage.objects policies are created on purpose: uploads and signed URLs
-- are issued server-side after an RLS-checked lookup + access log insert.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('documents', 'documents', false)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;

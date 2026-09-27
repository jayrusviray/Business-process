import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { addDays, type IsoDate } from "@/lib/dates";
import { numberSetting } from "./settings";

export type ApplicationRow = {
  id: string;
  app_no: string;
  client_id: string;
  client_name: string;
  type_label: string;
  service_line: string;
  status_key: string;
  status_label: string;
  status_kind: string;
  assigned: string | null;
  created_on: string;
  status_changed_on: string;
  balance: string;
  checklist_done: number;
  checklist_required: number;
  source: string;
};

export async function listApplications(
  tx: Tx,
  f: { view: "open" | "closed" | "all"; typeKey: string; statusKey: string; mine: boolean; userId: string; q: string },
): Promise<ApplicationRow[]> {
  const q = f.q.trim();
  return tx.execute<ApplicationRow>(sql`
    SELECT a.id, a.app_no, a.client_id, c.name AS client_name, t.label AS type_label, t.service_line, a.status_key,
      s.label AS status_label, s.kind AS status_kind,
      (SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = a.assigned_to) AS assigned,
      (a.created_at AT TIME ZONE 'Asia/Manila')::date::text AS created_on,
      (a.status_changed_at AT TIME ZONE 'Asia/Manila')::date::text AS status_changed_on,
      (COALESCE((SELECT SUM(amount_centavos) FROM public.application_fees WHERE application_id = a.id AND voided_at IS NULL), 0)
        - COALESCE((SELECT SUM(amount_centavos) FROM public.application_payments WHERE application_id = a.id AND voided_at IS NULL), 0))::text AS balance,
      (SELECT count(*)::int FROM public.application_checklist_items i WHERE i.application_id = a.id AND i.required AND i.verified_at IS NOT NULL) AS checklist_done,
      (SELECT count(*)::int FROM public.application_checklist_items i WHERE i.application_id = a.id AND i.required) AS checklist_required,
      a.source
    FROM public.applications a
    JOIN public.clients c ON c.id = a.client_id
    JOIN public.application_types t ON t.key = a.type_key
    JOIN public.application_statuses s ON s.key = a.status_key
    WHERE ${f.view === "open" ? sql`s.kind IN ('open', 'on_hold', 'approved')` : f.view === "closed" ? sql`s.kind IN ('completed', 'cancelled')` : sql`true`}
      AND ${f.typeKey ? sql`a.type_key = ${f.typeKey}` : sql`true`}
      AND ${f.statusKey ? sql`a.status_key = ${f.statusKey}` : sql`true`}
      AND ${f.mine ? sql`a.assigned_to = ${f.userId}` : sql`true`}
      AND (${q} = '' OR c.name ILIKE '%' || ${q} || '%' OR a.app_no ILIKE '%' || ${q} || '%' OR a.reference_no ILIKE '%' || ${q} || '%')
    ORDER BY s.sort, a.status_changed_at
    LIMIT 500`);
}

export type ExpiringDoc = {
  kind: "orcr" | "insurance" | "franchise";
  vehicle_id: string | null;
  plate_no: string | null;
  label: string;
  expires_on: string;
  client_id: string | null;
  client_name: string | null;
};

/**
 * OR/CR, insurance and franchise (PA/CPC) expiries within the warning window
 * (spec 4.2: 30/60 days), plus anything already expired on active units.
 */
export async function expiringDocuments(tx: Tx, today: IsoDate): Promise<{ rows: ExpiringDoc[]; warnDays: number; urgentDays: number }> {
  const [warnDays, urgentDays] = await Promise.all([
    numberSetting(tx, "alerts.document_expiry_warn_days", 60),
    numberSetting(tx, "alerts.document_expiry_urgent_days", 30),
  ]);
  const by = addDays(today, warnDays);
  const rows = await tx.execute<ExpiringDoc>(sql`
    SELECT 'orcr' AS kind, v.id AS vehicle_id, v.plate_no, 'OR/CR' AS label, v.orcr_expires_on::text AS expires_on, NULL::uuid AS client_id, NULL AS client_name
    FROM public.vehicles v WHERE v.status NOT IN ('transferred', 'retired') AND v.orcr_expires_on <= ${by}::date
    UNION ALL
    SELECT 'insurance', v.id, v.plate_no, 'Insurance', v.insurance_expires_on::text, NULL, NULL
    FROM public.vehicles v WHERE v.status NOT IN ('transferred', 'retired') AND v.insurance_expires_on <= ${by}::date
    UNION ALL
    SELECT 'franchise', f.vehicle_id, v.plate_no, f.kind::text || ' ' || f.number, f.expires_on::text, f.client_id, c.name
    FROM public.franchises f
    LEFT JOIN public.vehicles v ON v.id = f.vehicle_id
    LEFT JOIN public.clients c ON c.id = f.client_id
    WHERE f.expires_on <= ${by}::date AND f.expires_on >= ${addDays(today, -365)}::date
      AND (v.id IS NULL OR v.status NOT IN ('transferred', 'retired'))
    ORDER BY expires_on`);
  return { rows, warnDays, urgentDays };
}

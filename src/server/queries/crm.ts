import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";

export type BoardLead = {
  id: string;
  name: string;
  mobile: string;
  interest: string;
  source: string;
  stage_key: string;
  assigned_to: string | null;
  agent: string | null;
  created_on: string;
  next_due: string | null;
  updated_at: Date;
};

/**
 * Leads for the board. Open stages show everything; won/lost stages show the
 * last 30 days only. `who`: mine | unassigned | all.
 */
export async function boardLeads(tx: Tx, opts: { who: "mine" | "unassigned" | "all"; userId: string; q: string; source: string }): Promise<BoardLead[]> {
  const q = opts.q.trim();
  const digits = q.replace(/[^\d]/g, "");
  return tx.execute<BoardLead>(sql`
    SELECT l.id, l.name, l.mobile, l.interest, l.source, l.stage_key, l.assigned_to,
      (SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = l.assigned_to) AS agent,
      (l.created_at AT TIME ZONE 'Asia/Manila')::date::text AS created_on,
      (SELECT MIN(f.due_on)::text FROM public.lead_followups f WHERE f.lead_id = l.id AND f.done_at IS NULL) AS next_due,
      l.updated_at
    FROM public.leads l JOIN public.lead_stages s ON s.key = l.stage_key
    WHERE (s.kind = 'open' OR l.updated_at > now() - interval '30 days')
      AND ${opts.who === "mine" ? sql`l.assigned_to = ${opts.userId}` : opts.who === "unassigned" ? sql`l.assigned_to IS NULL` : sql`true`}
      AND ${opts.source ? sql`l.source::text = ${opts.source}` : sql`true`}
      AND (${q} = '' OR l.name ILIKE '%' || ${q} || '%' OR l.fb_name ILIKE '%' || ${q} || '%'
        OR (${digits} <> '' AND length(${digits}) >= 4 AND l.mobile LIKE '%' || ${digits} || '%'))
    ORDER BY l.updated_at DESC
    LIMIT 500`);
}

export type FollowupRow = { id: string; lead_id: string; lead_name: string; mobile: string; due_on: string; note: string; agent: string | null; stage: string };

export async function openFollowups(tx: Tx, opts: { userId: string; all: boolean }): Promise<FollowupRow[]> {
  return tx.execute<FollowupRow>(sql`
    SELECT f.id, f.lead_id, l.name AS lead_name, l.mobile, f.due_on::text, f.note,
      (SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = f.assigned_to) AS agent,
      s.label AS stage
    FROM public.lead_followups f JOIN public.leads l ON l.id = f.lead_id JOIN public.lead_stages s ON s.key = l.stage_key
    WHERE f.done_at IS NULL AND ${opts.all ? sql`true` : sql`f.assigned_to = ${opts.userId}`}
    ORDER BY f.due_on, l.name
    LIMIT 500`);
}

export async function overdueFollowupCount(tx: Tx, userId: string, today: string): Promise<number> {
  const [r] = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.lead_followups f
    WHERE f.done_at IS NULL AND f.assigned_to = ${userId} AND f.due_on <= ${today}::date`);
  return r?.n ?? 0;
}

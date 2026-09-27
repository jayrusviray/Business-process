import { sql } from "drizzle-orm";
import Link from "next/link";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday, daysBetween, type IsoDate } from "@/lib/dates";

export const metadata = { title: "Collect today" };

type Row = {
  driver_id: string; name: string; phone: string; plate_no: string | null;
  due_now: string; due_today: string; oldest: string; paid_today: string;
};

/**
 * Collector mode (mobile): every driver with something due up to today, oldest
 * arrears first, with one tap to record a payment.
 */
export default async function CollectTodayPage({ searchParams }: PageProps<"/app/collections/today">) {
  const session = await requireRole(["owner_admin", "finance", "operations"]);
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const today = businessToday();
  const rows = await withUserTx(session.claims, (tx) =>
    tx.execute<Row>(sql`
      WITH due AS (
        SELECT driver_id, SUM(outstanding_centavos)::bigint AS due_now,
          SUM(outstanding_centavos) FILTER (WHERE due_date = ${today}::date)::bigint AS due_today,
          MIN(due_date) AS oldest
        FROM public.v_charge_status
        WHERE status <> 'paid' AND due_date <= ${today}::date
        GROUP BY driver_id
      )
      SELECT d.id AS driver_id, d.first_name || ' ' || d.last_name AS name, d.phone,
        (SELECT v.plate_no FROM public.vehicle_assignments va JOIN public.vehicles v ON v.id = va.vehicle_id
          WHERE va.driver_id = d.id AND va.end_date IS NULL LIMIT 1) AS plate_no,
        due.due_now::text, COALESCE(due.due_today, 0)::text AS due_today, due.oldest::text,
        COALESCE((SELECT SUM(p.amount_centavos) FROM public.payments p
          WHERE p.driver_id = d.id AND p.business_date = ${today}::date
            AND NOT EXISTS (SELECT 1 FROM public.payment_voids pv WHERE pv.payment_id = p.id)), 0)::text AS paid_today
      FROM due JOIN public.drivers d ON d.id = due.driver_id
      WHERE d.status IN ('active', 'suspended')
        AND (${query} = '' OR d.first_name || ' ' || d.last_name ILIKE '%' || ${query} || '%' OR d.phone LIKE '%' || ${query} || '%')
      ORDER BY due.oldest, d.last_name`),
  );
  const total = rows.reduce((s, r) => s + BigInt(r.due_now), BigInt(0));

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Collect today" description={`${rows.length} driver(s) with dues up to ${today}. Total due now: `} />
      <p className="-mt-4 mb-4 text-lg font-semibold"><Money value={total} /></p>
      <form className="mb-4">
        <Input name="q" defaultValue={query} placeholder="Search name or mobile" className="h-12" aria-label="Search drivers" />
      </form>
      <ul className="flex flex-col gap-3">
        {rows.length === 0 ? <li className="text-sm text-muted-foreground">Everyone is paid up. 🎉</li> : null}
        {rows.map((r) => {
          const behind = daysBetween(r.oldest as IsoDate, today);
          return (
            <li key={r.driver_id}>
              <Link
                href={`/app/collections/new?driver=${r.driver_id}`}
                className="flex items-center justify-between gap-3 rounded-lg border p-4 active:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.plate_no ?? "No vehicle"} · {r.phone}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {behind > 0 ? <Badge variant={behind >= 3 ? "destructive" : "warning"}>{behind} day(s) behind</Badge> : <Badge variant="muted">due today</Badge>}
                    {BigInt(r.paid_today) > BigInt(0) ? <Badge variant="success">paid <Money value={r.paid_today} /> today</Badge> : null}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-lg font-semibold"><Money value={r.due_now} /></span>
                  <span className="text-sm text-primary underline">Record →</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

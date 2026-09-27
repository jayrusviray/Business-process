import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";

/** Active staff who can receive payments (operations, finance, owner_admin). */
export async function listCollectors(tx: Tx): Promise<{ id: string; name: string }[]> {
  return tx.execute<{ id: string; name: string }>(sql`
    SELECT DISTINCT p.id, COALESCE(NULLIF(p.full_name, ''), p.email, p.id::text) AS name
    FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id
    WHERE p.status = 'active' AND ur.role IN ('operations', 'finance', 'owner_admin')
    ORDER BY name`);
}

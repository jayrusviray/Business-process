import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";

export type StaffMember = { id: string; name: string; roles: string[] };

/** Active staff with their staff roles (app.staff_directory: visible to staff only). */
export async function staffDirectory(tx: Tx): Promise<StaffMember[]> {
  return tx.execute<StaffMember>(sql`SELECT id, name, roles FROM app.staff_directory() ORDER BY name`);
}

/** Active staff who can receive payments (operations, finance, owner_admin). */
export async function listCollectors(tx: Tx): Promise<{ id: string; name: string }[]> {
  return tx.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM app.staff_directory()
    WHERE roles && ARRAY['operations', 'finance', 'owner_admin']::text[]
    ORDER BY name`);
}

/** Staff who work leads (CRM agents). */
export async function listAgents(tx: Tx): Promise<{ id: string; name: string }[]> {
  return tx.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM app.staff_directory()
    WHERE roles && ARRAY['sales', 'operations', 'owner_admin']::text[]
    ORDER BY name`);
}

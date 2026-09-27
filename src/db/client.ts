import "server-only";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * The raw connection role BYPASSES RLS. Do not export `db` for general use.
 *   - User-facing code:  withUserTx(claims, tx => ...)   → RLS enforced
 *   - Cron / webhooks:   withSystemTx(label, tx => ...)  → RLS bypassed, audited by label
 */
type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __transrevDb?: Db };

function getDb(): Db {
  if (!globalForDb.__transrevDb) {
    // prepare:false is required behind Supabase's transaction pooler (Supavisor).
    const client = postgres(serverEnv().DATABASE_URL, { prepare: false, max: 5 });
    globalForDb.__transrevDb = drizzle(client, { schema });
  }
  return globalForDb.__transrevDb;
}

export type JwtClaims = { sub: string; role?: string; [k: string]: unknown };

/** Run queries as the signed-in user: `authenticated` role + JWT claims → RLS applies. */
export async function withUserTx<T>(claims: JwtClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`);
    await tx.execute(sql.raw("SET LOCAL ROLE authenticated"));
    return fn(tx);
  });
}

/**
 * Run as the system (RLS bypassed). `label` is recorded in the audit log,
 * e.g. "cron:daily-charges". Only for trusted server jobs — never with user input
 * deciding which rows are touched without explicit checks.
 */
export async function withSystemTx<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.actor_label', ${label}, true)`);
    return fn(tx);
  });
}

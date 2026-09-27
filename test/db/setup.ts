/**
 * Vitest globalSetup for DB integration tests: rebuilds the test database from
 * scratch (Supabase stub + all migrations) so tests exercise the real SQL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/transrev_test";

export default async function setup() {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS app CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await sql.unsafe(readFileSync(path.join(__dirname, "supabase-stub.sql"), "utf8"));
    await migrate(drizzle(sql), { migrationsFolder: path.join(__dirname, "../../drizzle") });
  } finally {
    await sql.end();
  }
}

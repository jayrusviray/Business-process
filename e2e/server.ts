/**
 * Starts the app for the public end-to-end tests (Playwright's webServer):
 *   1. rebuilds the e2e database from scratch (Supabase stub + all migrations),
 *   2. `next build`, 3. `next start` on the e2e port.
 * The database must be a throwaway one: its name has to contain "e2e".
 * Env: E2E_DATABASE_URL (default postgresql://postgres:postgres@localhost:5432/transrev_e2e),
 *      E2E_PORT (3300), E2E_NEXT_BUILD_FLAGS (e.g. "--webpack").
 */
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_PORT } from "./env";

const root = path.join(__dirname, "..");

async function resetDatabase(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/e2e/i.test(name)) throw new Error(`Refusing to reset "${name}": the e2e database name must contain "e2e".`);
  const admin = postgres({ ...parse(url), database: "postgres", max: 1, onnotice: () => {} });
  const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (!exists) await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  await admin.end();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS app CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;`);
    await sql.unsafe(readFileSync(path.join(root, "test/db/supabase-stub.sql"), "utf8"));
    await migrate(drizzle(sql), { migrationsFolder: path.join(root, "drizzle") });
  } finally {
    await sql.end();
  }
}

function parse(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

async function main() {
  await resetDatabase(E2E_DATABASE_URL);
  console.log(`e2e database ready: ${new URL(E2E_DATABASE_URL).pathname.slice(1)}`);
  execSync(`npx next build ${process.env.E2E_NEXT_BUILD_FLAGS ?? ""}`, { cwd: root, stdio: "inherit" });
  const server = spawn("npx", ["next", "start", "-p", String(E2E_PORT)], { cwd: root, stdio: "inherit" });
  const stop = () => server.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Fills a DEVELOPMENT database with demo data (60 days of history).
 * Usage: npm run db:seed:demo -- --yes [--today=YYYY-MM-DD]
 * Needs DATABASE_URL (the postgres connection; runs as the system, RLS bypassed)
 * and at least one active staff user (create them with `npm run db:seed:dev -- --yes`).
 * Refuses NODE_ENV=production, refuses without --yes, and refuses to run twice.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { businessToday, isIsoDate } from "../src/lib/dates";
import { seedDemo, type RunTx } from "../src/server/demo/seed";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production.");
  if (!process.argv.includes("--yes")) throw new Error("Pass --yes to confirm this is a development database.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const todayArg = process.argv.find((a) => a.startsWith("--today="))?.slice(8);
  if (todayArg && !isIsoDate(todayArg)) throw new Error("--today must be YYYY-MM-DD.");
  const today = todayArg && isIsoDate(todayArg) ? todayArg : businessToday();

  const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  const runTx: RunTx = (fn) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_label', 'seed:demo', true)`);
      return fn(tx);
    });
  try {
    const s = await seedDemo(runTx, { today });
    console.log(
      `Demo data ${s.from} → ${s.to}: ${s.drivers} drivers, ${s.vehicles} vehicles, ${s.contracts} RTO contracts, ` +
        `${s.charges} charges, ${s.payments} payments, ${s.leads} leads, ${s.applications} applications, ` +
        `${s.employees} employees, ${s.investors} investors.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

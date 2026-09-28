/**
 * Times the dashboard sections and every report against the perf database, as
 * the perf owner/admin through withUserTx (RLS applies, like production).
 * Seed first (scripts/perf/seed.ts), then:
 *   PERF_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/transrev_test_md_perf \
 *     npx vitest run --config scripts/perf/vitest.config.mts
 * Set PERF_EXPORTS=1 to also time the Excel and PDF generation.
 */
import { it } from "vitest";

const url = process.env.PERF_DATABASE_URL ?? "";
process.env.DATABASE_URL = url;
process.env.SUPABASE_SECRET_KEY ??= "perf";

it("measures dashboards and reports", async () => {
  if (!/\/[^/]*test[^/]*$/.test(url)) throw new Error("Set PERF_DATABASE_URL to the perf test database.");
  const { withUserTx, withSystemTx } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { businessToday } = await import("@/lib/dates");
  const { REPORTS } = await import("@/server/reports/registry");
  const { resolveContext } = await import("@/server/reports/types");
  const { runReport } = await import("@/server/reports/run");
  const { reportPdf, reportXlsx } = await import("@/server/reports/export");
  const dash = await import("@/server/queries/dashboard");

  const [owner] = await withSystemTx("perf", (tx) => tx.execute<{ id: string }>(sql`SELECT id FROM auth.users WHERE email = 'perf-owner@test.local'`));
  const claims = { sub: owner.id, role: "authenticated" };
  const today = businessToday();
  const out: string[] = [];
  const time = async <T>(label: string, fn: () => Promise<T>) => {
    const t = performance.now();
    const r = await fn();
    out.push(`${label.padEnd(48)} ${(performance.now() - t).toFixed(0).padStart(6)} ms`);
    return r;
  };

  // Warm-up (first connection, plan caches), like a live server.
  await withUserTx(claims, (tx) => tx.execute(sql`SELECT 1`));
  if (dash) {
    for (const [name, sections] of Object.entries(dash.DASHBOARDS_FOR_PERF)) {
      out.push(`— ${name} dashboard (sections run in parallel, each in its own transaction, as on the page) —`);
      const t0 = performance.now();
      await Promise.all(Object.entries(sections).map(([label, fn]) => time(label, () => withUserTx(claims, (tx) => fn(tx, today)))));
      out.push(`${`${name.toUpperCase()} PAGE TOTAL`.padEnd(48)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
    }
  }

  out.push("— cash book page (this month, one transaction as on the page) —");
  const cb = await import("@/server/queries/cashbook");
  const { addDays, startOfMonth } = await import("@/lib/dates");
  await time("cash book: balances + month rows + reconciliations", () =>
    withUserTx(claims, async (tx) => {
      await cb.listCashAccounts(tx);
      await cb.cashBalancesAtMany(tx, [addDays(startOfMonth(today), -1), today]);
      const rows = await cb.cashBookRows(tx, { from: startOfMonth(today), to: today });
      await cb.latestReconciliations(tx);
      await cb.unremittedCash(tx);
      return rows.length;
    }),
  );

  out.push("— reports (default ranges) —");
  for (const def of REPORTS) {
    await time(def.key, () =>
      withUserTx(claims, async (tx) => {
        const { ctx, options } = await resolveContext(tx, def, {}, { today, userId: owner.id, roles: ["owner_admin"] });
        if (def.key === "driver-statement") ctx.params.driver = options.driver[1]?.value ?? "";
        const doc = await runReport(tx, def, ctx);
        if (process.env.PERF_EXPORTS) {
          await reportXlsx(doc);
          if (doc.rows.length <= 3000) await reportPdf(doc);
        }
        return doc.rows.length;
      }),
    );
  }
  const text = out.join("\n");
  if (process.env.PERF_OUT) (await import("node:fs")).writeFileSync(process.env.PERF_OUT, `${text}\n`);
  console.log(text);
});

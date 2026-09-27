import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "./setup";
import { createUser, sql } from "./helpers";

// Point the app's db client at the test database before importing it.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SUPABASE_SECRET_KEY = "test";
const { withUserTx, withSystemTx } = await import("@/db/client");
const { appSettings, profiles } = await import("@/db/schema");
const { jsonb } = await import("@/db/sql");

let admin: string;
let driver: string;

beforeAll(async () => {
  admin = await createUser("Client Admin", ["owner_admin"]);
  driver = await createUser("Client Driver", ["driver"]);
});

afterAll(async () => {
  await sql.end();
});

describe("withUserTx", () => {
  it("runs as the authenticated role with the user's claims", async () => {
    const [r] = await withUserTx({ sub: driver, role: "authenticated" }, (tx) =>
      tx.execute<{ role: string; uid: string }>(dsql`SELECT current_user AS role, auth.uid()::text AS uid`),
    );
    expect(r).toMatchObject({ role: "authenticated", uid: driver });
  });

  it("enforces RLS through Drizzle queries", async () => {
    const rows = await withUserTx({ sub: driver }, (tx) => tx.select({ id: profiles.id }).from(profiles));
    expect(rows.map((r) => r.id)).toEqual([driver]);
  });

  it("does not leak role or claims to the next transaction on the pooled connection", async () => {
    await withUserTx({ sub: driver }, async () => {});
    const [r] = await withSystemTx("test", (tx) =>
      tx.execute<{ role: string; claims: string | null }>(
        dsql`SELECT current_user AS role, NULLIF(current_setting('request.jwt.claims', true), '') AS claims`,
      ),
    );
    expect(r.role).not.toBe("authenticated");
    expect(r.claims).toBeNull();
  });

  it("jsonb() stores JSON null and numbers with the right JSON types", async () => {
    await withSystemTx("test", (tx) =>
      tx.update(appSettings).set({ value: jsonb(null) }).where(dsql`${appSettings.key} = 'sms.sender_name'`),
    );
    const [v] = await sql`SELECT jsonb_typeof(value) AS t FROM public.app_settings WHERE key = 'sms.sender_name'`;
    expect(v.t).toBe("null");
  });

  it("audits writes with the user as actor", async () => {
    await withUserTx({ sub: admin }, async (tx) => {
      await tx.update(appSettings).set({ value: jsonb(4) }).where(dsql`${appSettings.key} = 'collections.delinquency_flag_months'`);
    });
    const [a] = await sql`SELECT actor_id FROM public.audit_log WHERE table_name = 'app_settings' ORDER BY id DESC LIMIT 1`;
    expect(a.actor_id).toBe(admin);
    await withUserTx({ sub: admin }, (tx) =>
      tx.update(appSettings).set({ value: jsonb(3) }).where(dsql`${appSettings.key} = 'collections.delinquency_flag_months'`),
    );
  });
});

describe("withSystemTx", () => {
  it("labels system writes in the audit log", async () => {
    await withSystemTx("cron:unit-test", (tx) =>
      tx.update(appSettings).set({ value: jsonb("TXTSENDER") }).where(dsql`${appSettings.key} = 'sms.sender_name'`),
    );
    const [a] = await sql`SELECT actor_id, actor_label FROM public.audit_log ORDER BY id DESC LIMIT 1`;
    expect(a).toMatchObject({ actor_id: null, actor_label: "cron:unit-test" });
    const [v] = await sql`SELECT jsonb_typeof(value) AS t, value #>> '{}' AS v FROM public.app_settings WHERE key = 'sms.sender_name'`;
    expect(v).toEqual({ t: "string", v: "TXTSENDER" });
    await withSystemTx("cron:unit-test", (tx) =>
      tx.update(appSettings).set({ value: jsonb(null) }).where(dsql`${appSettings.key} = 'sms.sender_name'`),
    );
  });
});

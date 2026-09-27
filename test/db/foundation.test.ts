import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settingsRegistry } from "@/lib/settings/registry";
import { govTableConfigSchemas } from "@/lib/settings/gov-tables";
import { asUser, createUser, sql } from "./helpers";

let admin: string, admin2: string, finance: string, ops: string, sales: string, driver: string, driver2: string;

beforeAll(async () => {
  admin = await createUser("Admin", ["owner_admin"]);
  admin2 = await createUser("Admin Two", ["owner_admin"]);
  finance = await createUser("Finance", ["finance"]);
  ops = await createUser("Ops", ["operations"]);
  sales = await createUser("Sales", ["sales"]);
  driver = await createUser("Driver", ["driver"]);
  driver2 = await createUser("Driver Two", ["driver"]);
});

afterAll(async () => {
  await sql.end();
});

describe("profiles", () => {
  it("is created automatically for a new auth user", async () => {
    const [p] = await sql`SELECT full_name FROM public.profiles WHERE id = ${driver}`;
    expect(p.full_name).toBe("Driver");
  });

  it("drivers only see their own profile", async () => {
    const rows = await asUser(driver, (tx) => tx`SELECT id FROM public.profiles`);
    expect(rows.map((r) => r.id)).toEqual([driver]);
  });

  it("staff can see all profiles", async () => {
    const rows = await asUser(ops, (tx) => tx`SELECT id FROM public.profiles`);
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it("anon sees nothing", async () => {
    await expect(asUser(null, (tx) => tx`SELECT id FROM public.profiles`)).rejects.toThrow(/permission denied/);
  });

  it("a user can rename themselves but cannot change their own status", async () => {
    const renamed = await asUser(driver, async (tx) => {
      await tx`UPDATE public.profiles SET full_name = 'Juan' WHERE id = ${driver}`;
      return tx`SELECT full_name FROM public.profiles WHERE id = ${driver}`;
    });
    expect(renamed[0].full_name).toBe("Juan");
    await expect(
      asUser(driver, (tx) => tx`UPDATE public.profiles SET status = 'disabled' WHERE id = ${driver}`),
    ).rejects.toThrow(/owner\/admin/);
  });

  it("a driver cannot update another user's profile", async () => {
    const res = await asUser(driver, (tx) => tx`UPDATE public.profiles SET full_name = 'x' WHERE id = ${driver2} RETURNING id`);
    expect(res.length).toBe(0);
  });
});

describe("user_roles", () => {
  it("non-admins cannot grant themselves roles", async () => {
    await expect(
      asUser(driver, (tx) => tx`INSERT INTO public.user_roles (user_id, role) VALUES (${driver}, 'owner_admin')`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(finance, (tx) => tx`INSERT INTO public.user_roles (user_id, role) VALUES (${finance}, 'owner_admin')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("owner_admin can grant roles, and the grant is audited with the actor", async () => {
    await asUser(admin, async (tx) => {
      await tx`INSERT INTO public.user_roles (user_id, role, granted_by) VALUES (${sales}, 'operations', ${admin})`;
      const [a] = await tx`
        SELECT actor_id, action, row_pk FROM public.audit_log
        WHERE table_name = 'user_roles' AND row_pk = ${`${sales}:operations`}`;
      expect(a).toMatchObject({ actor_id: admin, action: "INSERT" });
    });
  });

  it("a disabled owner_admin loses their powers", async () => {
    await sql`UPDATE public.profiles SET status = 'disabled' WHERE id = ${admin2}`;
    try {
      await expect(
        asUser(admin2, (tx) => tx`INSERT INTO public.user_roles (user_id, role) VALUES (${driver}, 'finance')`),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await sql`UPDATE public.profiles SET status = 'active' WHERE id = ${admin2}`;
    }
  });

  it("the last active owner_admin cannot be removed", async () => {
    await asUser(admin, async (tx) => {
      await tx`DELETE FROM public.user_roles WHERE user_id = ${admin2} AND role = 'owner_admin'`;
      await expect(
        tx`DELETE FROM public.user_roles WHERE user_id = ${admin} AND role = 'owner_admin'`,
      ).rejects.toThrow(/last active owner_admin/);
    });
  });
});

describe("audit_log", () => {
  it("records before/after and changed fields for updates", async () => {
    await asUser(admin, async (tx) => {
      await tx`UPDATE public.app_settings SET value = '5' WHERE key = 'collections.delinquency_flag_months'`;
      const [a] = await tx`
        SELECT actor_id, before->'value' AS before, after->'value' AS after, changed_fields
        FROM public.audit_log WHERE table_name = 'app_settings' AND action = 'UPDATE'
        ORDER BY id DESC LIMIT 1`;
      expect(a).toMatchObject({ actor_id: admin, before: 3, after: 5 });
      expect(a.changed_fields).toEqual(["value"]);
    });
  });

  it("records system actor labels for jobs", async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.actor_label', 'cron:test', true)`;
      await tx`UPDATE public.app_settings SET value = '"x"' WHERE key = 'sms.sender_name'`;
      const [a] = await tx`SELECT actor_id, actor_label FROM public.audit_log ORDER BY id DESC LIMIT 1`;
      expect(a).toMatchObject({ actor_id: null, actor_label: "cron:test" });
      await tx`UPDATE public.app_settings SET value = 'null' WHERE key = 'sms.sender_name'`;
    });
  });

  it("is readable by owner_admin and finance only", async () => {
    const f = await asUser(finance, (tx) => tx`SELECT count(*)::int AS n FROM public.audit_log`);
    expect(f[0].n).toBeGreaterThan(0);
    for (const u of [ops, sales, driver]) {
      const r = await asUser(u, (tx) => tx`SELECT count(*)::int AS n FROM public.audit_log`);
      expect(r[0].n).toBe(0);
    }
  });

  it("cannot be modified or deleted, even by the database owner", async () => {
    await expect(sql`UPDATE public.audit_log SET action = 'X'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM public.audit_log`).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE public.audit_log`).rejects.toThrow(/append-only/);
    await expect(asUser(admin, (tx) => tx`DELETE FROM public.audit_log`)).rejects.toThrow(/permission denied/);
  });
});

describe("settings", () => {
  it("every seeded setting matches its registry schema", async () => {
    const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM public.app_settings`;
    for (const { key, value } of rows) {
      const def = settingsRegistry[key as keyof typeof settingsRegistry];
      expect(def, `missing registry entry for ${key}`).toBeDefined();
      expect(() => def.schema.parse(value), key).not.toThrow();
    }
    expect(rows.length).toBe(Object.keys(settingsRegistry).length);
  });

  it("every seeded government table matches its config schema", async () => {
    const rows = await sql<{ agency: keyof typeof govTableConfigSchemas; config: unknown }[]>`
      SELECT agency, config FROM public.gov_contribution_tables`;
    expect(rows.length).toBe(4);
    for (const r of rows) expect(() => govTableConfigSchemas[r.agency].parse(r.config), r.agency).not.toThrow();
  });

  it("only owner_admin can change settings; drivers cannot read them", async () => {
    const res = await asUser(finance, (tx) =>
      tx`UPDATE public.app_settings SET value = 'true' WHERE key = 'collections.penalties_enabled' RETURNING key`,
    );
    expect(res.length).toBe(0);
    const d = await asUser(driver, (tx) => tx`SELECT key FROM public.app_settings`);
    expect(d.length).toBe(0);
  });

  it("gov tables are hidden from operations", async () => {
    const r = await asUser(ops, (tx) => tx`SELECT id FROM public.gov_contribution_tables`);
    expect(r.length).toBe(0);
  });
});

describe("documents", () => {
  it("sales only see application documents; drivers see none (until Phase 2 adds self-access)", async () => {
    await sql`
      INSERT INTO public.documents (owner_type, owner_id, doc_type, storage_path, file_name, mime_type, size_bytes)
      VALUES ('driver', gen_random_uuid(), 'drivers_license', ${`d/${crypto.randomUUID()}`}, 'lic.jpg', 'image/jpeg', 10),
             ('application', gen_random_uuid(), 'gov_id', ${`a/${crypto.randomUUID()}`}, 'id.jpg', 'image/jpeg', 10)`;
    const s = await asUser(sales, (tx) => tx`SELECT owner_type FROM public.documents`);
    expect(s.map((r) => r.owner_type)).toEqual(["application"]);
    const o = await asUser(ops, (tx) => tx`SELECT owner_type FROM public.documents`);
    expect(o.length).toBe(2);
    const d = await asUser(driver, (tx) => tx`SELECT owner_type FROM public.documents`);
    expect(d.length).toBe(0);
  });

  it("access log only accepts entries for yourself on documents you can see", async () => {
    const [doc] = await sql`SELECT id FROM public.documents WHERE owner_type = 'driver' LIMIT 1`;
    await asUser(ops, (tx) => tx`INSERT INTO public.document_access_log (document_id, actor_id) VALUES (${doc.id}, ${ops})`);
    await expect(
      asUser(sales, (tx) => tx`INSERT INTO public.document_access_log (document_id, actor_id) VALUES (${doc.id}, ${sales})`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(ops, (tx) => tx`INSERT INTO public.document_access_log (document_id, actor_id) VALUES (${doc.id}, ${admin})`),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("RLS coverage", () => {
  it("every table in public has RLS enabled", async () => {
    const rows = await sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("anon has no table privileges in public", async () => {
    const rows = await sql`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'anon' AND table_schema = 'public'`;
    expect(rows).toEqual([]);
  });
});

/**
 * Creates one demo user per role in a DEVELOPMENT Supabase project.
 * Usage: SEED_PASSWORD='...' npm run db:seed:dev -- --yes
 * Refuses to run without --yes, and never in production.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const ROLES = ["owner_admin", "finance", "operations", "sales", "driver", "investor"] as const;

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo users in production.");
  if (!process.argv.includes("--yes")) throw new Error("Pass --yes to confirm this is a development project.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const dbUrl = process.env.DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!url || !secret || !dbUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and DATABASE_URL are required.");
  if (!password || password.length < 12) throw new Error("Set SEED_PASSWORD (12+ characters).");

  const supabase = createClient(url, secret, { auth: { persistSession: false } });
  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    for (const role of ROLES) {
      const email = `demo+${role.replace("_", "-")}@transrev.test`;
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: `Demo ${role.replace("_", " ")}` },
      });
      if (error && !/already been registered/i.test(error.message)) throw error;
      const id =
        data.user?.id ?? (await sql<{ id: string }[]>`SELECT id FROM auth.users WHERE email = ${email}`)[0]?.id;
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.actor_label', 'seed:dev', true)`;
        await tx`INSERT INTO public.user_roles (user_id, role) VALUES (${id}, ${role}) ON CONFLICT DO NOTHING`;
      });
      console.log(`✓ ${email} (${role})`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

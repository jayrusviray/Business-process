/**
 * Makes an existing Supabase auth user the first owner/admin of a fresh project.
 * Usage: npm run admin:bootstrap -- --email you@example.com --yes [--force]
 *   1. Create or invite the user first (Supabase Dashboard → Authentication → Users).
 *   2. Run this with DATABASE_URL pointing at the project (after `npm run db:migrate`).
 * Refuses without --yes. If an active owner/admin already exists it refuses unless
 * --force (grant further admins from Admin → Users & roles instead).
 */
import "dotenv/config";
import postgres from "postgres";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  if (!process.argv.includes("--yes")) throw new Error("Pass --yes to confirm.");
  const email = arg("email")?.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Pass --email you@example.com (an existing Supabase auth user).");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.actor_label', 'script:bootstrap-admin', true)`;
      const users = await tx<{ id: string; email: string; phone: string | null; name: string }[]>`
        SELECT id, email, phone, COALESCE(raw_user_meta_data ->> 'full_name', '') AS name FROM auth.users WHERE lower(email) = ${email}`;
      if (users.length === 0) throw new Error(`No auth user with email ${email}. Create or invite it in Supabase first.`);
      const user = users[0];
      const admins = await tx<{ email: string | null }[]>`
        SELECT p.email FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id
        WHERE ur.role = 'owner_admin' AND p.status = 'active' AND ur.user_id <> ${user.id}`;
      if (admins.length && !process.argv.includes("--force")) {
        throw new Error(`An owner/admin already exists (${admins.map((a) => a.email).join(", ")}). Grant roles from Admin → Users & roles, or pass --force.`);
      }
      // The profile is normally created by a trigger on auth.users; users created before the migrations ran have none.
      await tx`
        INSERT INTO public.profiles (id, email, phone, full_name) VALUES (${user.id}, ${user.email}, ${user.phone}, ${user.name})
        ON CONFLICT (id) DO NOTHING`;
      await tx`UPDATE public.profiles SET status = 'active' WHERE id = ${user.id} AND status <> 'active'`;
      await tx`INSERT INTO public.user_roles (user_id, role) VALUES (${user.id}, 'owner_admin') ON CONFLICT DO NOTHING`;
    });
    console.log(`✓ ${email} is an owner/admin. Sign in at /login.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import postgres from "postgres";
import { TEST_DATABASE_URL } from "./setup";

export const sql = postgres(TEST_DATABASE_URL, { max: 4, onnotice: () => {} });

export type Role = "owner_admin" | "finance" | "operations" | "sales" | "driver" | "investor";

/** Creates an auth user (profile via trigger) and grants roles as a superuser. */
export async function createUser(name: string, roles: Role[] = []): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (email, raw_user_meta_data)
    VALUES (${`${name}-${crypto.randomUUID()}@test.local`}, ${sql.json({ full_name: name })})
    RETURNING id`;
  for (const role of roles) {
    await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${u.id}, ${role})`;
  }
  return u.id;
}

/**
 * Runs `fn` exactly like production withUserTx(): as the `authenticated`
 * role with the user's JWT claims, so RLS applies. Always rolls back.
 */
export async function asUser<T>(userId: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T;
  const rollback = new Error("__rollback__");
  try {
    await sql.begin(async (tx) => {
      const claims = userId ? { sub: userId, role: "authenticated" } : { role: "anon" };
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      await tx.unsafe(`SET LOCAL ROLE ${userId ? "authenticated" : "anon"}`);
      result = await fn(tx);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }
  return result!;
}

/** Asserts a promise rejects with a message (or Drizzle-wrapped cause) matching `re`. */
export async function expectDbError(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const text = `${err.message} ${err.cause?.message ?? ""}`;
    if (!re.test(text)) throw new Error(`expected error matching ${re}, got: ${text}`);
    return;
  }
  throw new Error(`expected rejection matching ${re}, but it resolved`);
}

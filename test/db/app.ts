/** Imports the app's DB client pointed at the test database. */
import { TEST_DATABASE_URL } from "./setup";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SUPABASE_SECRET_KEY ??= "test";

export const { withUserTx, withSystemTx } = await import("@/db/client");
export const schema = await import("@/db/schema");

/** Claims for a user id, as produced by Supabase getClaims(). */
export const as = (sub: string) => ({ sub, role: "authenticated" });

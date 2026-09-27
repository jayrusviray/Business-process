import { z } from "zod";

/** Public env (safe in the browser). Read lazily so builds don't need secrets. */
export function publicEnv() {
  return z
    .object({
      NEXT_PUBLIC_SUPABASE_URL: z.url(),
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    })
    .parse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    });
}

/** Server-only env. Never import from client components. */
export function serverEnv() {
  return z
    .object({
      DATABASE_URL: z.string().min(1),
      SUPABASE_SECRET_KEY: z.string().min(1),
      CRON_SECRET: z.string().min(16).optional(),
    })
    .parse(process.env);
}

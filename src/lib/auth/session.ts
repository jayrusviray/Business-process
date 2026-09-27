import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withUserTx, type JwtClaims } from "@/db/client";
import { profiles, userRoles } from "@/db/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasAnyRole, isStaff, type Role } from "./roles";

export type Session = {
  userId: string;
  claims: JwtClaims;
  roles: Role[];
  profile: { fullName: string; email: string | null; status: "active" | "disabled" };
};

/** Current user, verified via Supabase getClaims() (JWT signature checked). Cached per request. */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const claims = data.claims as unknown as JwtClaims;

  return withUserTx(claims, async (tx) => {
    const [profile] = await tx
      .select({ fullName: profiles.fullName, email: profiles.email, status: profiles.status })
      .from(profiles)
      .where(eq(profiles.id, claims.sub));
    if (!profile) return null;
    const roles =
      profile.status === "active"
        ? (await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, claims.sub))).map(
            (r) => r.role,
          )
        : [];
    return { userId: claims.sub, claims, roles, profile };
  });
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireRole(allowed: readonly Role[]): Promise<Session> {
  const session = await requireSession();
  if (!hasAnyRole(session.roles, allowed)) redirect("/forbidden");
  return session;
}

export async function requireStaff(): Promise<Session> {
  const session = await requireSession();
  if (!isStaff(session.roles)) redirect(session.roles.length ? "/portal" : "/pending");
  return session;
}

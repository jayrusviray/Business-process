import "server-only";
import { eq } from "drizzle-orm";
import { withUserTx } from "@/db/client";
import { drivers, userRoles } from "@/db/schema";
import type { Session } from "@/lib/auth/session";
import { phToE164, temporaryPassword } from "@/lib/phone";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { MoneyRuleError } from "./money/errors";

/**
 * Gives a driver portal access: creates a login with their mobile number and a
 * temporary password (no SMS needed; staff hand the password over in person),
 * links it to the driver record and grants the 'driver' role. The permission
 * check happens first, under RLS, as the staff user.
 */
export async function grantPortalAccess(session: Session, driverId: string): Promise<{ phone: string; password: string }> {
  const driver = await withUserTx(session.claims, async (tx) => {
    const [d] = await tx.select().from(drivers).where(eq(drivers.id, driverId));
    return d;
  });
  if (!driver) throw new MoneyRuleError("Driver not found.");
  if (driver.profileId) throw new MoneyRuleError("This driver already has portal access. Reset the password instead.");

  const phone = phToE164(driver.phone);
  const password = temporaryPassword();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
    user_metadata: { full_name: `${driver.firstName} ${driver.lastName}` },
  });
  if (error || !data.user) {
    throw new MoneyRuleError(/already|exists|registered/i.test(error?.message ?? "") ? "That mobile number already has a login." : `Could not create login: ${error?.message}`);
  }
  try {
    await withUserTx(session.claims, async (tx) => {
      await tx.update(drivers).set({ profileId: data.user.id }).where(eq(drivers.id, driverId));
      await tx.insert(userRoles).values({ userId: data.user.id, role: "driver", grantedBy: session.userId });
    });
  } catch (e) {
    await admin.auth.admin.deleteUser(data.user.id).catch(() => {});
    throw e;
  }
  return { phone: driver.phone, password };
}

export async function resetPortalPassword(session: Session, driverId: string): Promise<{ phone: string; password: string }> {
  const driver = await withUserTx(session.claims, async (tx) => {
    const [d] = await tx.select().from(drivers).where(eq(drivers.id, driverId));
    return d;
  });
  if (!driver?.profileId) throw new MoneyRuleError("This driver has no portal access yet.");
  const password = temporaryPassword();
  const { error } = await createSupabaseAdminClient().auth.admin.updateUserById(driver.profileId, { password });
  if (error) throw new MoneyRuleError(`Could not reset password: ${error.message}`);
  return { phone: driver.phone, password };
}

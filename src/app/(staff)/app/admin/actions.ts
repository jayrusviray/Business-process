"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { appSettings, govContributionTables, profiles, userRoles } from "@/db/schema";
import { jsonb } from "@/db/sql";
import { requireRole } from "@/lib/auth/session";
import { ROLES } from "@/lib/auth/roles";
import { isIsoDate } from "@/lib/dates";
import { govTableConfigSchemas } from "@/lib/settings/gov-tables";
import { isSettingKey, settingsRegistry } from "@/lib/settings/registry";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type ActionState = { ok?: string; error?: string };

function dbError(e: unknown): ActionState {
  const msg = e instanceof Error ? e.message : String(e);
  if (/last active owner_admin/.test(msg)) return { error: "You cannot remove the last active owner/admin." };
  if (/row-level security|permission denied/.test(msg)) return { error: "You are not allowed to do that." };
  if (/duplicate key/.test(msg)) return { error: "That record already exists." };
  console.error(e);
  return { error: "Something went wrong. Nothing was saved." };
}

const RoleChange = z.object({
  userId: z.uuid(),
  role: z.enum(ROLES),
  op: z.enum(["grant", "revoke"]),
});

export async function changeRole(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin"]);
  const input = RoleChange.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Invalid input." };
  const { userId, role, op } = input.data;
  try {
    await withUserTx(session.claims, async (tx) => {
      if (op === "grant") {
        await tx.insert(userRoles).values({ userId, role, grantedBy: session.userId }).onConflictDoNothing();
      } else {
        await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)));
      }
    });
  } catch (e) {
    return dbError(e);
  }
  revalidatePath("/app/admin/users");
  return { ok: op === "grant" ? "Role granted." : "Role removed." };
}

const StatusChange = z.object({ userId: z.uuid(), status: z.enum(["active", "disabled"]) });

export async function setUserStatus(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin"]);
  const input = StatusChange.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Invalid input." };
  if (input.data.userId === session.userId) return { error: "You cannot disable your own account." };
  try {
    await withUserTx(session.claims, (tx) =>
      tx.update(profiles).set({ status: input.data.status }).where(eq(profiles.id, input.data.userId)),
    );
  } catch (e) {
    return dbError(e);
  }
  revalidatePath("/app/admin/users");
  return { ok: `User ${input.data.status === "active" ? "enabled" : "disabled"}.` };
}

const Invite = z.object({
  email: z.email(),
  fullName: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
});

/** Invite a staff/driver/investor user by email and grant their first role. */
export async function inviteUser(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin"]);
  const input = Invite.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Invalid input." };

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(input.data.email, {
    data: { full_name: input.data.fullName },
  });
  if (error || !data.user) return { error: error?.message ?? "Could not invite user." };
  try {
    await withUserTx(session.claims, (tx) =>
      tx.insert(userRoles).values({ userId: data.user.id, role: input.data.role, grantedBy: session.userId }),
    );
  } catch (e) {
    return dbError(e);
  }
  revalidatePath("/app/admin/users");
  return { ok: `Invitation sent to ${input.data.email}.` };
}

const SettingUpdate = z.object({ key: z.string(), value: z.string() });

export async function updateSetting(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin"]);
  const input = SettingUpdate.safeParse(Object.fromEntries(formData));
  if (!input.success || !isSettingKey(input.data.key)) return { error: "Unknown setting." };
  const def = settingsRegistry[input.data.key];
  if ("readOnly" in def && def.readOnly) return { error: "This setting is read-only." };

  let json: unknown;
  try {
    json = JSON.parse(input.data.value);
  } catch {
    return { error: "Value must be valid JSON." };
  }
  const parsed = def.schema.safeParse(json);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ") };

  try {
    await withUserTx(session.claims, (tx) =>
      tx.update(appSettings).set({ value: jsonb(parsed.data) }).where(eq(appSettings.key, input.data.key)),
    );
  } catch (e) {
    return dbError(e);
  }
  revalidatePath("/app/admin/settings");
  return { ok: "Saved." };
}

const GovTableInput = z.object({
  agency: z.enum(["sss", "philhealth", "pagibig", "bir_wtax"]),
  effectiveFrom: z.string().refine(isIsoDate, "Use YYYY-MM-DD"),
  config: z.string(),
  notes: z.string().max(1000).default(""),
});

/** Government tables are versioned: add a new effective-dated row instead of editing history. */
export async function addGovTable(_: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireRole(["owner_admin"]);
  const input = GovTableInput.safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Invalid input." };
  let json: unknown;
  try {
    json = JSON.parse(input.data.config);
  } catch {
    return { error: "Config must be valid JSON." };
  }
  const parsed = govTableConfigSchemas[input.data.agency].safeParse(json);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  try {
    await withUserTx(session.claims, (tx) =>
      tx.insert(govContributionTables).values({
        agency: input.data.agency,
        effectiveFrom: input.data.effectiveFrom,
        config: jsonb(parsed.data),
        notes: input.data.notes,
      }),
    );
  } catch (e) {
    return dbError(e);
  }
  revalidatePath("/app/admin/settings");
  return { ok: "New table version added." };
}

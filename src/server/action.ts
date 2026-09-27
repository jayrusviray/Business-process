import "server-only";
import { requireRole, type Session } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/roles";
import { friendlyError } from "./money/errors";

export type ActionState = { ok?: string; error?: string };

/**
 * Standard server-action wrapper: role check, then run `fn`, mapping any
 * error to a safe message. `fn` returns the success message.
 */
export async function guarded(roles: readonly Role[], fn: (session: Session) => Promise<string>): Promise<ActionState> {
  const session = await requireRole(roles);
  try {
    return { ok: await fn(session) };
  } catch (e) {
    return { error: friendlyError(e) };
  }
}

/** FormData → plain object of strings (files dropped). */
export function formObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

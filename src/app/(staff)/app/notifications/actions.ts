"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withUserTx } from "@/db/client";
import { notifications } from "@/db/schema";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { guarded, type ActionState } from "@/server/action";

export async function markAllReadAction(): Promise<ActionState> {
  return guarded(STAFF_ROLES, async (s) => {
    await withUserTx(s.claims, (tx) =>
      tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, s.userId), isNull(notifications.readAt))),
    );
    revalidatePath("/app", "layout");
    return "All caught up.";
  });
}

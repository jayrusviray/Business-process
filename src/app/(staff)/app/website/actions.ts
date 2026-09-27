"use server";

import { eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { siteBlocks } from "@/db/schema";
import { SERVICE_LINES } from "@/lib/crm";
import { formObject, guarded, type ActionState } from "@/server/action";
import { MoneyRuleError } from "@/server/money/errors";
import { SITE_CACHE_TAG } from "@/server/public/site";

const EDITORS = ["owner_admin", "sales"] as const;
const SECTIONS = ["hero", "service", "audience", "step", "requirement", "program", "faq", "school", "privacy"] as const;

const BlockInput = z.object({
  section: z.enum(SECTIONS),
  title: z.string().trim().min(2, "Give it a title.").max(200),
  body: z.string().trim().max(5000).default(""),
  serviceLine: z.union([z.literal(""), z.enum(SERVICE_LINES)]).transform((v) => v || null),
  sort: z.coerce.number().int().min(0).max(1000),
  active: z.string().optional().transform((v) => v === "on"),
});

function refresh() {
  // Visitors see the change on their next page load.
  revalidateTag(SITE_CACHE_TAG, { expire: 0 });
  revalidatePath("/app/website");
}

export async function saveBlockAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(EDITORS, async (s) => {
    const input = BlockInput.safeParse(obj);
    if (!input.success) throw new MoneyRuleError(input.error.issues[0]?.message ?? "Check the form.");
    const id = obj.id ? z.guid().parse(obj.id) : null;
    await withUserTx(s.claims, (tx) =>
      id ? tx.update(siteBlocks).set(input.data).where(eq(siteBlocks.id, id)) : tx.insert(siteBlocks).values(input.data),
    );
    refresh();
    return id ? "Saved. The website is updated." : "Added to the website.";
  });
}

export async function deleteBlockAction(_: ActionState, formData: FormData): Promise<ActionState> {
  const obj = formObject(formData);
  return guarded(EDITORS, async (s) => {
    const id = z.guid().parse(obj.id);
    await withUserTx(s.claims, (tx) => tx.delete(siteBlocks).where(eq(siteBlocks.id, id)));
    refresh();
    return "Deleted.";
  });
}

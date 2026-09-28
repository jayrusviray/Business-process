"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUserTx } from "@/db/client";
import { requireRole } from "@/lib/auth/session";
import { businessToday } from "@/lib/dates";
import { IMPORT_KINDS } from "@/lib/imports/kinds";
import { zIsoDate } from "@/lib/validation";
import { friendlyError } from "@/server/money/errors";
import { ImportFileError, MAX_IMPORT_BYTES, readImportFile, sha256Hex } from "@/server/imports/read";
import { runImport, type ImportOutcome } from "@/server/imports/service";

export type ImportState = { ok?: string; error?: string; result?: ImportOutcome };

const Input = z.object({
  kind: z.enum(IMPORT_KINDS),
  intent: z.enum(["preview", "import"]),
  date: z.union([z.literal(""), zIsoDate]).optional().transform((v) => v || null),
  assignTo: z.union([z.literal(""), z.guid()]).optional().transform((v) => v || null),
});

/** Preview (dry run) or import one spreadsheet. Nothing is written unless every row is valid. */
export async function importAction(_: ImportState, formData: FormData): Promise<ImportState> {
  const session = await requireRole(["owner_admin"]);
  const parsed = Input.safeParse({
    kind: formData.get("kind"),
    intent: formData.get("intent"),
    date: formData.get("date") ?? "",
    assignTo: formData.get("assignTo") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a .csv or .xlsx file." };
  if (file.size > MAX_IMPORT_BYTES) return { error: "The file is too large (max 5 MB). Split it into smaller files." };
  const { kind, intent, date, assignTo } = parsed.data;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const table = await readImportFile(file.name, bytes);
    const result = await withUserTx(session.claims, (tx) =>
      runImport(tx, {
        kind,
        fileName: file.name,
        sha256: sha256Hex(bytes),
        table,
        commit: intent === "import",
        today: businessToday(),
        date,
        assignLeadsTo: assignTo,
      }),
    );
    if (result.problem) return { error: result.problem, result };
    const { errors, ready, skipped, rows } = result.counts;
    if (result.committed) {
      revalidatePath("/app/import");
      return { ok: `Imported ${rows} row(s): ${ready} saved, ${skipped} already there (skipped).`, result };
    }
    if (errors) return { error: `${errors} of ${rows} row(s) need fixing. Nothing was imported.`, result };
    return { ok: `All ${rows} row(s) look good: ${ready} to save, ${skipped} already there. Click Import to save.`, result };
  } catch (e) {
    return { error: e instanceof ImportFileError ? e.message : friendlyError(e) };
  }
}

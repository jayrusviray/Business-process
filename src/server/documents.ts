import "server-only";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { documentAccessLog, documents } from "@/db/schema";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { MoneyRuleError } from "./money/errors";

const BUCKET = "documents";
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]);

/**
 * Uploads a file to the private bucket and records it in `documents`
 * (inside the caller's RLS transaction, so only permitted staff can attach).
 */
export async function uploadDocument(
  tx: Tx,
  input: { file: File; ownerType: string; ownerId: string; docType: string; uploadedBy: string },
): Promise<string> {
  if (input.file.size > MAX_BYTES) throw new MoneyRuleError("File is too large (max 8 MB).");
  if (!ALLOWED.has(input.file.type)) throw new MoneyRuleError("Upload a photo (JPG/PNG/WebP/HEIC) or a PDF.");
  const ext = input.file.name.includes(".") ? input.file.name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  const path = `${input.ownerType}/${input.ownerId}/${crypto.randomUUID()}.${ext}`;
  const [doc] = await tx
    .insert(documents)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      docType: input.docType,
      storagePath: path,
      fileName: input.file.name.slice(0, 200),
      mimeType: input.file.type,
      sizeBytes: input.file.size,
      uploadedBy: input.uploadedBy,
    })
    .returning({ id: documents.id });
  const { error } = await createSupabaseAdminClient()
    .storage.from(BUCKET)
    .upload(path, input.file, { contentType: input.file.type, upsert: false });
  if (error) throw new MoneyRuleError(`Upload failed: ${error.message}`);
  return doc.id;
}

/**
 * Returns a 60-second signed URL if (and only if) RLS lets the user see the
 * document, and records the access (Data Privacy Act).
 */
export async function signedDocumentUrl(tx: Tx, documentId: string, actorId: string): Promise<string | null> {
  const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return null;
  await tx.insert(documentAccessLog).values({ documentId, actorId, purpose: "view" });
  const { data, error } = await createSupabaseAdminClient().storage.from(BUCKET).createSignedUrl(doc.storagePath, 60);
  if (error || !data) return null;
  return data.signedUrl;
}

import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { appSettings } from "@/db/schema";

/** Reads a numeric app setting (visible under RLS), with a fallback. */
export async function numberSetting(tx: Tx, key: string, fallback: number): Promise<number> {
  const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  return typeof row?.value === "number" ? row.value : fallback;
}

/** Reads any app setting's raw JSON value, or null. */
export async function rawSetting(tx: Tx, key: string): Promise<unknown> {
  const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  return row?.value ?? null;
}

import { sql, type SQL } from "drizzle-orm";

/**
 * Explicit jsonb literal. Use for every jsonb write: Drizzle maps JS `null` to
 * SQL NULL (not JSON null), and driver-level JSON handling differs between
 * postgres-js and other drivers. This is unambiguous for all values.
 */
export function jsonb(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}

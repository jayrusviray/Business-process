import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // Supabase owns auth/storage; we only manage our own schemas.
  schemaFilter: ["public"],
  entities: { roles: { provider: "supabase" } },
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});

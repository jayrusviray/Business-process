import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Performance measurement (M-D). NOT part of `npm test`: it needs the perf
 * database seeded by scripts/perf/seed.ts.
 *   PERF_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/transrev_test_md_perf \
 *     npx vitest run --config scripts/perf/vitest.config.mts
 */
const root = path.resolve(import.meta.dirname, "../..");
export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      "server-only": path.join(root, "test/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["scripts/perf/**/*.perf.ts"],
    environment: "node",
    testTimeout: 900_000,
    fileParallelism: false,
  },
});

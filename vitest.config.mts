import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // Next's "server-only" guard throws outside the react-server condition.
  "server-only": path.resolve(import.meta.dirname, "test/stubs/server-only.ts"),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/db/setup.ts"],
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});

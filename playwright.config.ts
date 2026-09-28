import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_PORT } from "./e2e/env";

/**
 * End-to-end tests (npm run test:e2e).
 * - Locally (no E2E_BASE_URL): builds and starts the app on port 3300 against a
 *   freshly migrated throwaway database (E2E_DATABASE_URL, name must contain "e2e"),
 *   with a placeholder Supabase URL. Public flows run; signed-in flows are skipped.
 * - Against a deployed app with a real Supabase: set E2E_BASE_URL, E2E_STAFF_EMAIL and
 *   E2E_STAFF_PASSWORD to run the signed-in flows too.
 */
const baseURL = E2E_BASE_URL || `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "retain-on-failure", locale: "en-PH", timezoneId: "Asia/Manila" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: E2E_BASE_URL
    ? undefined
    : {
        command: "npx tsx e2e/server.ts",
        url: `${baseURL}/api/health`,
        timeout: 600_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        env: {
          NODE_ENV: "production",
          E2E_DATABASE_URL,
          DATABASE_URL: E2E_DATABASE_URL,
          NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-placeholder",
          SUPABASE_SECRET_KEY: "e2e-placeholder",
          CRON_SECRET: "e2e-cron-secret-0123456789",
          NEXT_PUBLIC_SITE_URL: baseURL,
          RATE_LIMIT_SALT: "e2e-salt",
        },
      },
});

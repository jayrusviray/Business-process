/** Settings shared by playwright.config.ts, the e2e web server and the specs. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3300);

/** Remote target (e.g. a Vercel preview). When unset, Playwright builds and starts the app locally. */
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "";

/** Local throwaway database (rebuilt on every local run; its name must contain "e2e"). */
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/transrev_e2e";

/** DB assertions run against the local e2e database, or a remote one only if E2E_DATABASE_URL is given explicitly. */
export const E2E_DB_CHECKS = !E2E_BASE_URL || !!process.env.E2E_DATABASE_URL;

export const STAFF = { email: process.env.E2E_STAFF_EMAIL ?? "", password: process.env.E2E_STAFF_PASSWORD ?? "" };
export const HAS_STAFF_LOGIN = !!(E2E_BASE_URL && STAFF.email && STAFF.password);

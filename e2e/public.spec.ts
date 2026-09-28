import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_DB_CHECKS } from "./env";

/** Fails the test on CSP violations or uncaught page errors (proves the CSP doesn't break Next's scripts). */
function watchErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  return problems;
}

/** A fresh visitor IP per test, so the inquiry rate limit never trips across runs. */
async function freshVisitor(page: Page) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}, 10.0.0.1` });
}

test("landing page renders with security headers @mobile", async ({ page }) => {
  const problems = watchErrors(page);
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["x-powered-by"]).toBeUndefined();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Our services" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Send us an inquiry" })).toBeVisible();
  expect(problems).toEqual([]);
});

test('"Ask about this" pre-selects the service', async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: /Ask about this/ }).first();
  const href = await link.getAttribute("href");
  const service = new URLSearchParams(href!.split("#")[0].replace(/^\?/, "")).get("interest");
  expect(service).toBeTruthy();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`interest=${service}`));
  await expect(page.getByLabel("Service you're interested in")).toHaveValue(service!);
});

test("inquiry form needs consent, then thanks the visitor and creates a lead @mobile", async ({ page }) => {
  const problems = watchErrors(page);
  await freshVisitor(page);
  const mobile = `0917${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const name = `E2E Visitor ${Date.now()}`;
  await page.goto("/?interest=franchise#inquire");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Mobile number").fill(mobile);
  await page.getByLabel("City / province").fill("Quezon City");
  await page.getByLabel("Message").fill("Magkano po ang CPC renewal?");

  // Without consent the browser blocks the submission.
  await page.getByRole("button", { name: "Send inquiry" }).click();
  const consent = page.getByRole("checkbox");
  expect(await consent.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  await expect(page.getByText("Salamat! We got your inquiry.")).toHaveCount(0);

  await consent.check();
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await expect(page.getByText("Salamat! We got your inquiry.")).toBeVisible();
  expect(problems).toEqual([]);

  if (E2E_DB_CHECKS) {
    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`SELECT name, source, interest, consent_at IS NOT NULL AS consent FROM public.leads WHERE mobile = ${mobile}`;
      expect(rows).toEqual([{ name, source: "landing_page", interest: "franchise", consent: true }]);
    } finally {
      await sql.end();
    }
  }
});

test("school and privacy pages render", async ({ page }) => {
  const problems = watchErrors(page);
  for (const path of ["/school", "/privacy"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test("the staff app redirects to login when signed out", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp/);
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("health check answers without secrets", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["at", "db", "ok"]);
  expect(body).toMatchObject({ ok: true, db: "ok" });
});

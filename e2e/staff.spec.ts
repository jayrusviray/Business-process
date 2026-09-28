import { expect, test, type Page } from "@playwright/test";
import { HAS_STAFF_LOGIN, STAFF } from "./env";

/**
 * Signed-in flows. They need a deployed app with a real Supabase project and a
 * staff user (owner/admin, finance or operations, with demo data so there is a
 * driver to collect from): set E2E_BASE_URL, E2E_STAFF_EMAIL, E2E_STAFF_PASSWORD.
 * Skipped otherwise.
 */
test.skip(!HAS_STAFF_LOGIN, "Needs E2E_BASE_URL, E2E_STAFF_EMAIL and E2E_STAFF_PASSWORD (real Supabase)");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email or mobile number").fill(STAFF.email);
  await page.getByLabel("Password").fill(STAFF.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(\/|$|\?)/);
}

test("login lands on the dashboard", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /Welcome/ })).toBeVisible();
});

test("record a payment and see the receipt", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/collections/new");
  await page.getByRole("list").getByRole("link").first().click();
  await expect(page).toHaveURL(/driver=/);
  await page.getByLabel(/Boundary amount/).fill("1.00");
  await page.getByRole("button", { name: /Record ₱1\.00/ }).click();
  await expect(page).toHaveURL(/\/app\/collections\/receipts\/[0-9a-f-]{36}\?saved=1/);
  await expect(page.getByText("Payment recorded.")).toBeVisible();
  await expect(page.getByText(/AR-\d{6}/)).toBeVisible();
});

test("create a CRM lead", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/crm/new");
  const name = `E2E Lead ${Date.now()}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Mobile").fill(`0919${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`);
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page).toHaveURL(/\/app\/crm\/[0-9a-f-]{36}/);
  await expect(page.getByText(name).first()).toBeVisible();
});

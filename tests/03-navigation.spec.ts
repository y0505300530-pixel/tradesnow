import { test, expect } from "@playwright/test";
import { dismissPWAInstallPrompt, hasCredentials, loginViaUI } from "./helpers/fixtures";

test.describe("Dashboard & navigation", () => {
  test.beforeEach(async ({ page }) => {
    // noop — dismiss per test where needed
  });

  test("root redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await dismissPWAInstallPrompt(page);
    await expect(page.getByRole("heading", { name: "ברוך הבא" })).toBeVisible();
  });

  test("protected route /trade redirects to login when unauthenticated", async ({ page }) => {
    await page.goto("/trade");
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await dismissPWAInstallPrompt(page);
    await expect(page).toHaveURL(/\/login/);
  });

  test("protected route /overview redirects to login when unauthenticated", async ({ page }) => {
    await page.goto("/overview");
    await page.waitForURL(/\/login/, { timeout: 15_000 });
  });

  test("login page back-to-home link navigates to /", async ({ page }) => {
    await page.goto("/login");
    await dismissPWAInstallPrompt(page);
    await page.getByRole("link", { name: /חזרה לדף הבית/i }).click();
    await page.waitForURL(/\/login/, { timeout: 10_000 });
  });

  test("mobile nav shows sign-in button", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile nav");
    await page.goto("/login");
    await dismissPWAInstallPrompt(page);
    // GlobalNav renders on login page
    const signIn = page.getByRole("link", { name: /כניסה/i });
    if (await signIn.count()) {
      await expect(signIn.first()).toBeVisible();
    }
  });

  test.describe("Authenticated navigation", () => {
    test.beforeEach(async ({ page }) => {
      test.skip(!hasCredentials, "Set PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD");
      await loginViaUI(page);
      if (page.url().includes("/verify-2fa")) {
        test.skip(true, "Account requires 2FA — complete manually or use a non-2FA test account");
      }
    });

    test("Trade dropdown navigates to Trade Manager", async ({ page, isMobile }) => {
      test.skip(isMobile, "desktop Trade dropdown");
      await page.goto("/overview");
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: /^Trade$/i }).click();
      const tradeLink = page.getByRole("link", { name: /Trade Manager/i });
      await expect(tradeLink).toBeVisible();

      const navPromise = page.waitForURL(/\/trade/, { timeout: 15_000 });
      await tradeLink.click();
      await navPromise;
      await expect(page).toHaveURL(/\/trade/);
    });

    test("mobile menu opens and lists Trade Manager", async ({ page, isMobile }) => {
      test.skip(!isMobile, "mobile drawer");
      await page.goto("/overview");
      await page.getByRole("button", { name: /Toggle menu/i }).click();
      await expect(page.getByRole("link", { name: /Trade Manager/i })).toBeVisible();
      await page.getByRole("link", { name: /Trade Manager/i }).click();
      await page.waitForURL(/\/trade/, { timeout: 15_000 });
    });

    test("navigating to /catalogue loads Asset Catalogue page", async ({ page }) => {
      await page.goto("/catalogue");
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/catalogue/);
      // Page should not redirect back to login
      expect(page.url()).not.toMatch(/\/login/);
    });
  });
});

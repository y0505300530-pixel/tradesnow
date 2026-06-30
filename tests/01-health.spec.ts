import { test, expect } from "@playwright/test";
import { dismissPWAInstallPrompt } from "./helpers/fixtures";

test.describe("Site health & responsiveness", () => {
  test.beforeEach(async ({ page }) => {
    page.on("load", async () => {
      await dismissPWAInstallPrompt(page);
    });
  });

  test("homepage loads with valid HTML and viewport meta", async ({ page }) => {
    const response = await page.goto("/login");
    await dismissPWAInstallPrompt(page);
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/TradeSnow|TS/i);
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute("content", /width=device-width/);
  });

  test("critical static assets return 200", async ({ request }) => {
    for (const path of ["/sw.js", "/manifest.json", "/pwa-192.png", "/favicon.ico"]) {
      const res = await request.get(path);
      expect(res.status(), `${path} should load`).toBe(200);
    }
  });

  test("page renders login form on mobile viewport", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-only layout check");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "ברוך הבא" })).toBeVisible();
    await expect(page.getByPlaceholder("כתובת אימייל")).toBeVisible();
    await expect(page.getByPlaceholder("סיסמה")).toBeVisible();
    await expect(page.getByRole("button", { name: "כנס" })).toBeVisible();
  });

  test("page renders login form on desktop viewport", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only layout check");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "ברוך הבא" })).toBeVisible();
    await expect(page.getByText("תסחר חכם יותר")).toBeVisible();
  });

  test("response time under 5 seconds", async ({ page }) => {
    const start = Date.now();
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

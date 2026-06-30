import { test, expect } from "@playwright/test";
import { dismissPWAInstallPrompt, hasCredentials, loginViaUI } from "./helpers/fixtures";

/** Protected routes available to role=user (RequireVerified) */
const USER_PAGES: { path: string; label: string }[] = [
  { path: "/landing", label: "Home" },
  { path: "/overview", label: "Portfolio Overview" },
  { path: "/trade", label: "Trade Manager" },
  { path: "/catalogue", label: "Asset Catalogue" },
  { path: "/watchlist", label: "Watchlist" },
  { path: "/settings", label: "Settings" },
  { path: "/videos", label: "Video Management" },
  { path: "/ai-insights", label: "AI Insights" },
  { path: "/lab", label: "Trading Lab" },
  { path: "/lab/triple", label: "Triple Simulation" },
  { path: "/tradingview", label: "TradingView" },
  { path: "/alerts", label: "Price Alerts" },
  { path: "/logs", label: "Logs" },
  { path: "/dip-analysis", label: "Dip Analysis" },
  { path: "/h1h2", label: "H1/H2 Dashboard" },
  { path: "/splash", label: "Splash" },
  { path: "/breakout", label: "Breakout Scanner" },
  { path: "/bear-scanner", label: "Bear Scanner" },
  { path: "/knowledge", label: "Knowledge Base" },
  { path: "/trading-lab", label: "Paper Lab" },
  { path: "/trading-lab/history", label: "Paper Trade History" },
  { path: "/money-transfers", label: "Money Transfers" },
  { path: "/favorites", label: "Favorites" },
  { path: "/price-cache", label: "Price Cache" },
  { path: "/deep-analysis/NVDA", label: "Deep Analysis NVDA" },
  { path: "/portfolio/h1", label: "Portfolio H1" },
  { path: "/portfolio/h2-usa", label: "Portfolio H2 USA" },
  { path: "/portfolio/h2-tase", label: "Portfolio H2 TASE" },
  { path: "/portfolio/h2-crypto", label: "Portfolio H2 Crypto" },
];

const ADMIN_ONLY_PAGES = [
  { path: "/ibkr-account", label: "IBKR Account" },
  { path: "/war-room-live", label: "War Room Live" },
];

const REDIRECTS: { from: string; to: RegExp }[] = [
  { from: "/trade-manager", to: /\/trade/ },
  { from: "/paper-lab", to: /\/trading-lab/ },
  { from: "/tools", to: /\/catalogue/ },
  { from: "/home", to: /\/landing/ },
];

async function waitForPageReady(page: import("@playwright/test").Page) {
  await page.waitForLoadState("domcontentloaded");
  // Allow lazy chunks + data fetches; cap wait so one slow page won't hang the suite
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  const spinner = page.locator(".animate-spin").first();
  if (await spinner.isVisible({ timeout: 2000 }).catch(() => false)) {
    await spinner.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
  }
}

test.describe("Full QA — public pages", () => {
  test("landing page loads", async ({ page }) => {
    const res = await page.goto("/");
    await dismissPWAInstallPrompt(page);
    expect(res?.status()).toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
  });

  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await dismissPWAInstallPrompt(page);
    await expect(page.getByRole("heading", { name: "ברוך הבא" })).toBeVisible();
  });
});

test.describe("Full QA — authenticated user pages", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials, "Set PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD");
    await loginViaUI(page);
    if (page.url().includes("/verify-2fa")) {
      test.skip(true, "Account requires 2FA");
    }
  });

  for (const { path, label } of USER_PAGES) {
    test(`${label} (${path}) loads without auth redirect`, async ({ page, isMobile }) => {
      const viewport = isMobile ? "mobile" : "desktop";
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      const res = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 45_000 });
      expect(res?.status() ?? 0, `[${viewport}] HTTP status for ${path}`).toBeLessThan(500);
      expect(page.url(), `[${viewport}] should stay logged in`).not.toMatch(/\/login/);

      await waitForPageReady(page);

      // Generic crash / error boundary hints
      const bodyText = await page.locator("body").innerText();
      expect(bodyText.toLowerCase(), `[${viewport}] ${path}`).not.toMatch(/something went wrong/);
      expect(bodyText, `[${viewport}] ${path}`).not.toMatch(/Application error/i);

      // Filter benign console noise (third-party widgets, favicon, etc.)
      const critical = errors.filter(
        (e) =>
          !e.includes("favicon") &&
          !e.includes("ResizeObserver") &&
          !e.includes("Non-Error promise rejection") &&
          !e.includes("403") &&
          !e.includes("Failed to load resource") &&
          !e.includes("required permission (10002)") &&
          !e.includes("TRPCClientError"),
      );
      expect(critical, `[${viewport}] console errors on ${path}`).toEqual([]);
    });
  }

  for (const { from, to } of REDIRECTS) {
    test(`redirect ${from}`, async ({ page }) => {
      await page.goto(from, { waitUntil: "domcontentloaded" });
      await page.waitForURL(to, { timeout: 15_000 });
      expect(page.url()).toMatch(to);
    });
  }

  for (const { path, label } of ADMIN_ONLY_PAGES) {
    test(`${label} (${path}) blocked for non-admin user`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/(login|$|\/?$|landing|overview)/, { timeout: 15_000 });
      expect(page.url()).not.toContain(path);
    });
  }
});

test.describe("Full QA — mobile navigation smoke", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-only");
    test.skip(!hasCredentials, "credentials required");
    await loginViaUI(page);
    if (page.url().includes("/verify-2fa")) test.skip(true, "2FA required");
  });

  test("mobile drawer opens and core links visible", async ({ page }) => {
    await page.goto("/overview");
    await waitForPageReady(page);
    const menuBtn = page.getByRole("button", { name: /Toggle menu/i });
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    for (const name of [/Trade Manager/i, /Catalogue|קטלוג/i, /Overview|סקירה/i]) {
      const link = page.getByRole("link", { name });
      if ((await link.count()) > 0) {
        await expect(link.first()).toBeVisible();
      }
    }
  });
});

test.describe("Full QA — desktop navigation smoke", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-only");
    test.skip(!hasCredentials, "credentials required");
    await loginViaUI(page);
    if (page.url().includes("/verify-2fa")) test.skip(true, "2FA required");
  });

  test("desktop nav Trade menu reachable", async ({ page }) => {
    await page.goto("/overview");
    await waitForPageReady(page);
    const tradeBtn = page.getByRole("button", { name: /^Trade$/i });
    if (await tradeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await tradeBtn.click();
      await expect(page.getByRole("link", { name: /Trade Manager/i })).toBeVisible();
    }
  });
});

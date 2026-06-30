/**
 * Mobile QA — 375px viewport, trading UX flows (screenshots only, no live orders).
 * Run: PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test tests/mobile-trading-ux-375.spec.ts --project=mobile-375
 */
import { test, expect, devices } from "@playwright/test";
import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "docs/superpowers/screenshots/mobile-375");

test.use({
  ...devices["iPhone SE"],
  viewport: { width: 375, height: 812 },
});

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

test.describe("Manual trading UX @ 375px", () => {
  test("catalogue + deep analysis command bar", async ({ page }) => {
    await page.goto("/catalogue", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, "01-catalogue.png"), fullPage: false });

    const firstTicker = page.locator("table tbody tr button, [data-ticker], .ticker-cell").first();
    if (await firstTicker.count() > 0) {
      await firstTicker.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      const analyzeBtn = page.getByRole("button", { name: /analyze|ניתוח|deep/i }).first();
      if (await analyzeBtn.count() > 0) await analyzeBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: path.join(OUT, "02-deep-analysis-modal.png"), fullPage: false });

    const buyBtn = page.getByRole("button", { name: /^BUY$/i }).first();
    if (await buyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await buyBtn.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, "03-manual-order-dialog.png"), fullPage: false });
      await page.keyboard.press("Escape");
    }
  });

  test("war room liquidate hold button", async ({ page }) => {
    await page.goto("/war-room", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, "04-war-room-positions.png"), fullPage: false });

    const liquidate = page.locator('button[title*="חיסול"], button[aria-label*="חיסול"]').first();
    if (await liquidate.isVisible({ timeout: 8000 }).catch(() => false)) {
      await liquidate.focus();
      await page.screenshot({ path: path.join(OUT, "05-liquidate-button.png"), fullPage: false });
    }
  });
});

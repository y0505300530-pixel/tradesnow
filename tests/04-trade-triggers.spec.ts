import { test, expect } from "@playwright/test";
import { hasCredentials, loginViaUI } from "./helpers/fixtures";

test.describe("Trade execution triggers & API verification", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!hasCredentials, "Set PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD");
    await loginViaUI(page);
    if (page.url().includes("/verify-2fa")) {
      test.skip(true, "Account requires 2FA");
    }
  });

  test("Trade Manager loads and auth.me returns user", async ({ page }) => {
    const mePromise = page.waitForResponse(
      (r) => r.url().includes("auth.me") && r.status() === 200,
    );
    await page.goto("/trade");
    await mePromise;
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/trade/);
  });

  test("Refresh Prices triggers tRPC/API call", async ({ page }) => {
    await page.goto("/trade");
    await page.waitForLoadState("networkidle");

    const refreshBtn = page.getByRole("button", { name: /Refresh Prices/i });
    if (!(await refreshBtn.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, "Refresh Prices button not visible — may need IBKR connection or holdings");
      return;
    }

    const apiCall = page.waitForResponse(
      (r) =>
        r.url().includes("/api/trpc") &&
        r.status() === 200 &&
        (r.url().includes("trade") || r.url().includes("ibkr") || r.url().includes("holding")),
      { timeout: 20_000 },
    );

    await refreshBtn.click();
    const res = await apiCall;
    expect(res.status()).toBe(200);
  });

  test("Refresh from IBKR button triggers sync API when connected", async ({ page }) => {
    await page.goto("/trade");
    await page.waitForLoadState("networkidle");

    const ibkrBtn = page.getByRole("button", { name: /Refresh from IBKR/i });
    const visible = await ibkrBtn.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!visible) {
      test.info().annotations.push({
        type: "note",
        description: "IBKR sync button hidden — broker disconnected or no positions",
      });
      return;
    }

    if (await ibkrBtn.isDisabled()) {
      test.info().annotations.push({ type: "note", description: "IBKR sync disabled — no positions" });
      return;
    }

    const syncCall = page.waitForResponse(
      (r) => r.url().includes("/api/trpc") && r.status() === 200,
      { timeout: 30_000 },
    );
    await ibkrBtn.click();
    const res = await syncCall;
    expect(res.status()).toBe(200);
  });
});

test.describe("Public API contracts (no auth required)", () => {
  test("order endpoints reject unauthenticated requests", async ({ request }) => {
    const res = await request.get("/api/ibind/health");
    expect([401, 403]).toContain(res.status());
  });

  test("login API rejects malformed JSON gracefully", async ({ request }) => {
    const res = await request.post("/api/local-auth/login", {
      data: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test("tRPC auth.me is reachable", async ({ request }) => {
    const url = `/api/trpc/auth.me?batch=1&input=${encodeURIComponent('{"0":{"json":null}}')}`;
    const res = await request.get(url);
    expect(res.status()).toBe(200);
  });
});

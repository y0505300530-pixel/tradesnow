import { test, expect } from "@playwright/test";
import { apiLogin, dismissPWAInstallPrompt, hasCredentials, loginViaUI } from "./helpers/fixtures";

test.describe("Login flow & API contracts", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await dismissPWAInstallPrompt(page);
  });

  test("submit button disabled until email and password filled", async ({ page }) => {
    const submit = page.getByRole("button", { name: "כנס" });
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder("כתובת אימייל").fill("test@example.com");
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder("סיסמה").fill("x");
    await expect(submit).toBeEnabled();
  });

  test("empty credentials rejected by API", async ({ request }) => {
    const res = await request.post("/api/local-auth/login", {
      data: {},
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  test("invalid credentials return 401 and show error UI", async ({ page }) => {
    await page.getByPlaceholder("כתובת אימייל").fill("e2e-invalid@test.local");
    await page.getByPlaceholder("סיסמה").fill("wrong-password-xyz");

    const resPromise = page.waitForResponse(
      (r) => r.url().includes("/api/local-auth/login") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "כנס" }).click();

    const res = await resPromise;
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
    await expect(page.getByText(/שגיאה|invalid/i)).toBeVisible();
  });

  test("auth.me returns null when unauthenticated", async ({ request }) => {
    const url = `/api/trpc/auth.me?batch=1&input=${encodeURIComponent('{"0":{"json":null}}')}`;
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json[0].result.data.json).toBeNull();
  });

  test("password visibility toggle works", async ({ page }) => {
    const pw = page.getByPlaceholder("סיסמה");
    await pw.fill("secret123");
    await expect(pw).toHaveAttribute("type", "password");
    await page.locator('form button[type="button"]').click();
    await expect(pw).toHaveAttribute("type", "text");
  });

  test("valid login succeeds and sets session", async ({ page, request }) => {
    test.skip(!hasCredentials, "Set PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD");

    const { status, body } = await apiLogin(
      request,
      process.env.PLAYWRIGHT_TEST_EMAIL!,
      process.env.PLAYWRIGHT_TEST_PASSWORD!,
    );
    expect(status).toBe(200);
    expect(body).toHaveProperty("success", true);

    await loginViaUI(page);
    const meUrl = `/api/trpc/auth.me?batch=1&input=${encodeURIComponent('{"0":{"json":null}}')}`;
    const meRes = await page.request.get(meUrl);
    const meJson = await meRes.json();
    expect(meJson[0].result.data.json).not.toBeNull();
  });
});

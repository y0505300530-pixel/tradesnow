import { expect, type Page, type APIRequestContext } from "@playwright/test";

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://trade-snow2.vip";

export const hasCredentials = Boolean(
  process.env.PLAYWRIGHT_TEST_EMAIL && process.env.PLAYWRIGHT_TEST_PASSWORD,
);

/** Login via UI and optionally complete 2FA redirect wait */
export async function dismissPWAInstallPrompt(page: Page) {
  const later = page.getByRole("button", { name: /אחר כך/i });
  if (await later.isVisible({ timeout: 2000 }).catch(() => false)) {
    await later.click();
  }
}

export async function loginViaUI(page: Page) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL!;
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD!;

  await page.goto("/login");
  await dismissPWAInstallPrompt(page);
  await page.getByPlaceholder("כתובת אימייל").fill(email);
  await page.getByPlaceholder("סיסמה").fill(password);

  const loginResponse = page.waitForResponse(
    (r) => r.url().includes("/api/local-auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "כנס" }).click();
  const res = await loginResponse;
  expect(res.status()).toBeLessThan(400);

  // Wait for post-login navigation (trade, splash, or 2FA)
  await page.waitForURL(/\/(trade|splash|verify-2fa|overview|landing)/, { timeout: 20_000 });
}

export async function waitForAuthMe(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes("/api/trpc/auth.me") && r.status() === 200,
    { timeout: 20_000 },
  );
}

export async function apiAuthMe(request: APIRequestContext) {
  const url = `${BASE_URL}/api/trpc/auth.me?batch=1&input=${encodeURIComponent('{"0":{"json":null}}')}`;
  const res = await request.get(url);
  return { status: res.status(), body: await res.json() };
}

export async function apiLogin(
  request: APIRequestContext,
  email: string,
  password: string,
) {
  const res = await request.post(`${BASE_URL}/api/local-auth/login`, {
    data: { email, password },
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status(), body: await res.json() };
}

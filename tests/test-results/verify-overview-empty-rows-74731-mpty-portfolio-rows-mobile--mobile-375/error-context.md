# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: verify-overview-empty-rows.spec.ts >> overview hides empty portfolio rows (mobile)
- Location: tests/verify-overview-empty-rows.spec.ts:9:3

# Error details

```
TimeoutError: locator.textContent: Timeout 15000ms exceeded.
Call log:
  - waiting for locator('text=H2 USA').first().locator('xpath=ancestor::div[contains(@class,\'grid\')]').first()

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - region "Notifications alt+T"
  - generic [ref=e3]:
    - banner [ref=e4]:
      - generic [ref=e6]:
        - link "TS TS TradeSnow v1.00" [ref=e7] [cursor=pointer]:
          - /url: /overview
          - img "TS" [ref=e9]
          - generic [ref=e10]:
            - generic [ref=e11]: TS
            - generic [ref=e12]: TradeSnow
          - generic [ref=e13]: v1.00
        - generic [ref=e14]:
          - generic [ref=e15]: P
          - button "Toggle menu" [ref=e16] [cursor=pointer]:
            - img [ref=e17]
    - main [ref=e18]:
      - generic [ref=e19]:
        - generic [ref=e20]:
          - generic [ref=e21]:
            - generic [ref=e22]:
              - generic [ref=e23]:
                - generic [ref=e24]: TradeSnow
                - generic [ref=e25]:
                  - generic [ref=e26]: Overview
                  - generic [ref=e27]: 🟡 Pre-Market
              - generic [ref=e29]:
                - generic [ref=e30]:
                  - img [ref=e31]
                  - text: נסיון חוזר...
                - button "התחבר" [ref=e38] [cursor=pointer]:
                  - img
                  - text: התחבר
            - generic [ref=e44]:
              - generic [ref=e45]:
                - generic [ref=e46]: Last Update
                - generic [ref=e47]: —
              - button "Refresh prices" [ref=e48] [cursor=pointer]:
                - img [ref=e49]
          - generic [ref=e54]:
            - generic [ref=e55]:
              - generic [ref=e56]: TA-35
              - generic [ref=e57]: 4,058
              - generic [ref=e58]: +0.74%
            - generic [ref=e59]:
              - generic [ref=e60]: S&P 500
              - generic [ref=e61]: 7,354
              - generic [ref=e62]: "-0.05%"
            - generic [ref=e63]:
              - generic [ref=e64]: NASDAQ
              - generic [ref=e65]: 25,298
              - generic [ref=e66]: "-0.24%"
        - generic [ref=e67]:
          - generic [ref=e68]:
            - generic [ref=e69]: Name
            - generic [ref=e70]: Value/Cost
            - generic [ref=e71]: Today
            - generic [ref=e72]: Total
          - generic [ref=e74]:
            - generic [ref=e76]:
              - generic [ref=e77]: Cash
              - generic [ref=e78]: 1 position
            - generic [ref=e79]:
              - generic [ref=e80]: $0
              - generic [ref=e81]: $0
            - generic [ref=e82]:
              - generic [ref=e83]: —
              - generic [ref=e84]: "+0"
            - generic [ref=e85]:
              - generic [ref=e86]: —
              - generic [ref=e87]: "+0"
          - generic [ref=e90]:
            - generic [ref=e91]:
              - generic [ref=e92]: All Accounts
              - generic [ref=e93]: USD
            - generic [ref=e95]: $0
            - generic [ref=e96]:
              - generic [ref=e97]: —
              - generic [ref=e98]: "+0"
            - generic [ref=e99]:
              - generic [ref=e100]: +0.00%
              - generic [ref=e101]: "+0"
          - generic [ref=e102]:
            - generic [ref=e103]:
              - button "₪ ILS" [ref=e104] [cursor=pointer]
              - button "$ USD" [ref=e105] [cursor=pointer]
            - generic [ref=e106]:
              - generic [ref=e107]:
                - generic [ref=e108]:
                  - generic [ref=e109]: שווי תיק
                  - generic [ref=e110]: ILS ₪
                - generic [ref=e111]:
                  - generic [ref=e112]: ₪0
                  - generic [ref=e113]: +₪0 שינוי מאתמול
              - generic [ref=e114]:
                - generic [ref=e115]:
                  - generic [ref=e116]: שער דולר/שקל
                  - generic [ref=e117]: "2.991"
                - generic [ref=e118]:
                  - generic [ref=e119]: USD assets (H1 + H2 USA + Crypto)
                  - generic [ref=e120]: ₪0
              - generic [ref=e121]:
                - generic [ref=e122]:
                  - generic [ref=e123]: רווח/הפסד מט"ח 24ש
                  - generic [ref=e124]: $0 × Δשער
                - generic [ref=e125]:
                  - generic [ref=e126]: +0.739%
                  - generic [ref=e127]: +₪0
          - generic [ref=e129]:
            - img [ref=e131]:
              - generic [ref=e140]: "25"
            - generic [ref=e141]:
              - generic [ref=e142]: Fear & Greed Index
              - generic [ref=e143]: פחד קיצוני
              - generic [ref=e144]: Last updated Jun 29, 3:38 AM ET
              - generic [ref=e145]: "מקור: CNN Business"
          - generic [ref=e147]:
            - img [ref=e149]:
              - generic [ref=e153]: "10"
              - generic [ref=e154]: "20"
              - generic [ref=e155]: "30"
              - generic [ref=e156]: "40"
              - generic [ref=e160]: "18.47"
            - generic [ref=e161]:
              - generic [ref=e162]: מד "מהירות הפחד" — VIX
              - generic [ref=e163]: נמוך (רגוע)
              - generic [ref=e164]: "טווח 52 שבועות: 13.47 – 31.05"
              - generic [ref=e165]:
                - generic [ref=e166]: נמוך <20
                - generic [ref=e168]: בינוני 20–30
                - generic [ref=e170]: גבוה ≥30
  - generic [ref=e174]:
    - img "TS" [ref=e176]
    - generic [ref=e177]:
      - paragraph [ref=e178]: התקן את TS
      - paragraph [ref=e179]: הוסף למסך הבית לגישה מהירה
      - generic [ref=e180]:
        - button "הוראות" [ref=e181] [cursor=pointer]:
          - img [ref=e182]
          - text: הוראות
        - button "אחר כך" [ref=e185] [cursor=pointer]
    - button [ref=e186] [cursor=pointer]:
      - img [ref=e187]
```

# Test source

```ts
  1  | /**
  2  |  * One-off verification: empty H2 groups hidden on /overview (desktop + mobile).
  3  |  * Requires PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD in tests/.env
  4  |  */
  5  | import { test, expect } from "@playwright/test";
  6  | import { dismissPWAInstallPrompt, loginViaUI, hasCredentials } from "./helpers/fixtures";
  7  | 
  8  | for (const label of ["desktop", "mobile"]) {
  9  |   test(`overview hides empty portfolio rows (${label})`, async ({ page }) => {
  10 |     test.skip(!hasCredentials, "tests/.env credentials required");
  11 | 
  12 |     if (label === "mobile") {
  13 |       await page.setViewportSize({ width: 375, height: 812 });
  14 |     } else {
  15 |       await page.setViewportSize({ width: 1280, height: 800 });
  16 |     }
  17 | 
  18 |     await loginViaUI(page);
  19 |     await page.goto("/overview");
  20 |     await dismissPWAInstallPrompt(page);
  21 |     await page.waitForSelector("text=Overview", { timeout: 30_000 });
  22 | 
  23 |     const h2UsaRow = page.locator("text=H2 USA").first();
  24 |     if (await h2UsaRow.isVisible({ timeout: 3000 }).catch(() => false)) {
> 25 |       const rowText = await h2UsaRow.locator("xpath=ancestor::div[contains(@class,'grid')]").first().textContent();
     |                                                                                                      ^ TimeoutError: locator.textContent: Timeout 15000ms exceeded.
  26 |       expect(rowText, "H2 USA row must not show 0 positions").not.toMatch(/0 positions/);
  27 |     }
  28 | 
  29 |     await page.screenshot({
  30 |       path: `tests/test-results/overview-empty-rows-${label}.png`,
  31 |       fullPage: true,
  32 |     });
  33 |   });
  34 | }
  35 | 
```
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: verify-overview-empty-rows.spec.ts >> overview hides empty portfolio rows (desktop)
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
        - navigation [ref=e14]:
          - link "Home" [ref=e15] [cursor=pointer]:
            - /url: /overview
            - img [ref=e16]
            - generic [ref=e19]: Home
          - button "Trade" [ref=e21] [cursor=pointer]:
            - img [ref=e22]
            - generic [ref=e25]: Trade
            - img [ref=e26]
          - button "Tools" [ref=e29] [cursor=pointer]:
            - img [ref=e30]
            - generic [ref=e32]: Tools
            - img [ref=e33]
          - button "Knowledge" [ref=e36] [cursor=pointer]:
            - img [ref=e37]
            - generic [ref=e39]: Knowledge
            - img [ref=e40]
        - generic [ref=e43]:
          - generic [ref=e44]: P
          - generic [ref=e45]: Playwright QA
          - button "Sign out" [ref=e46] [cursor=pointer]:
            - img [ref=e47]
    - main [ref=e50]:
      - generic [ref=e51]:
        - generic [ref=e52]:
          - generic [ref=e53]:
            - generic [ref=e54]:
              - generic [ref=e55]:
                - generic [ref=e56]: TradeSnow
                - generic [ref=e57]:
                  - generic [ref=e58]: Overview
                  - generic [ref=e59]: 🟡 Pre-Market
              - generic [ref=e61]:
                - generic [ref=e62]:
                  - img [ref=e63]
                  - text: נסיון חוזר...
                - button "התחבר" [ref=e70] [cursor=pointer]:
                  - img [ref=e71]
                  - text: התחבר
            - generic [ref=e77]:
              - generic [ref=e78]:
                - generic [ref=e79]: Last Update
                - generic [ref=e80]: —
              - button "Refresh prices" [ref=e81] [cursor=pointer]:
                - img [ref=e82]
          - generic [ref=e87]:
            - generic [ref=e88]:
              - generic [ref=e89]: TA-35
              - generic [ref=e90]: 4,058
              - generic [ref=e91]: +0.74%
            - generic [ref=e92]:
              - generic [ref=e93]: S&P 500
              - generic [ref=e94]: 7,354
              - generic [ref=e95]: "-0.05%"
            - generic [ref=e96]:
              - generic [ref=e97]: NASDAQ
              - generic [ref=e98]: 25,298
              - generic [ref=e99]: "-0.24%"
        - generic [ref=e100]:
          - generic [ref=e101]:
            - generic [ref=e102]: Name
            - generic [ref=e103]: Value/Cost
            - generic [ref=e104]: Today
            - generic [ref=e105]: Total
          - generic [ref=e107]:
            - generic [ref=e109]:
              - generic [ref=e110]: Cash
              - generic [ref=e111]: 1 position
            - generic [ref=e112]:
              - generic [ref=e113]: $0
              - generic [ref=e114]: $0
            - generic [ref=e115]:
              - generic [ref=e116]: —
              - generic [ref=e117]: "+0"
            - generic [ref=e118]:
              - generic [ref=e119]: —
              - generic [ref=e120]: "+0"
          - generic [ref=e123]:
            - generic [ref=e124]:
              - generic [ref=e125]: All Accounts
              - generic [ref=e126]: USD
            - generic [ref=e128]: $0
            - generic [ref=e129]:
              - generic [ref=e130]: —
              - generic [ref=e131]: "+0"
            - generic [ref=e132]:
              - generic [ref=e133]: +0.00%
              - generic [ref=e134]: "+0"
          - generic [ref=e135]:
            - generic [ref=e136]:
              - button "₪ ILS" [ref=e137] [cursor=pointer]
              - button "$ USD" [ref=e138] [cursor=pointer]
            - generic [ref=e139]:
              - generic [ref=e140]:
                - generic [ref=e141]:
                  - generic [ref=e142]: שווי תיק
                  - generic [ref=e143]: ILS ₪
                - generic [ref=e144]:
                  - generic [ref=e145]: ₪0
                  - generic [ref=e146]: +₪0 שינוי מאתמול
              - generic [ref=e147]:
                - generic [ref=e148]:
                  - generic [ref=e149]: שער דולר/שקל
                  - generic [ref=e150]: "2.991"
                - generic [ref=e151]:
                  - generic [ref=e152]: USD assets (H1 + H2 USA + Crypto)
                  - generic [ref=e153]: ₪0
              - generic [ref=e154]:
                - generic [ref=e155]:
                  - generic [ref=e156]: רווח/הפסד מט"ח 24ש
                  - generic [ref=e157]: $0 × Δשער
                - generic [ref=e158]:
                  - generic [ref=e159]: +0.739%
                  - generic [ref=e160]: +₪0
          - generic [ref=e162]:
            - img [ref=e164]:
              - generic [ref=e173]: "25"
            - generic [ref=e174]:
              - generic [ref=e175]: Fear & Greed Index
              - generic [ref=e176]: פחד קיצוני
              - generic [ref=e177]: Last updated Jun 29, 3:38 AM ET
              - generic [ref=e178]: "מקור: CNN Business"
          - generic [ref=e180]:
            - img [ref=e182]:
              - generic [ref=e186]: "10"
              - generic [ref=e187]: "20"
              - generic [ref=e188]: "30"
              - generic [ref=e189]: "40"
              - generic [ref=e193]: "18.47"
            - generic [ref=e194]:
              - generic [ref=e195]: מד "מהירות הפחד" — VIX
              - generic [ref=e196]: נמוך (רגוע)
              - generic [ref=e197]: "טווח 52 שבועות: 13.47 – 31.05"
              - generic [ref=e198]:
                - generic [ref=e199]: נמוך <20
                - generic [ref=e201]: בינוני 20–30
                - generic [ref=e203]: גבוה ≥30
  - generic [ref=e207]:
    - img "TS" [ref=e209]
    - generic [ref=e210]:
      - paragraph [ref=e211]: התקן את TS
      - paragraph [ref=e212]: גישה מהירה, ללא דפדפן
      - generic [ref=e213]:
        - button "התקן" [ref=e214] [cursor=pointer]:
          - img [ref=e215]
          - text: התקן
        - button "אחר כך" [ref=e218] [cursor=pointer]
    - button [ref=e219] [cursor=pointer]:
      - img [ref=e220]
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
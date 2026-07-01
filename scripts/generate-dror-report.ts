/**
 * Dror portfolio ELZA 4.5 report — before/after holdings with USD values.
 * Output: reports/dror-elza-portfolio-report.pdf
 */
import "dotenv/config";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { fetchBarsForTicker, getUsdIlsRate } from "../server/marketData.ts";
import { genesisScore, scoreLong } from "../server/engine/elzaV45Master.ts";
import { calcZivEngineScore } from "../server/zivEngine.ts";
import { getTickerIntelligence } from "../server/runtimeIntelligence.ts";

const HOLDINGS = [
  { ticker: "NET", qty: 4 }, { ticker: "MPC", qty: 4 }, { ticker: "ORCL", qty: 21 },
  { ticker: "NFLX", qty: 65 }, { ticker: "SKWD", qty: 20 }, { ticker: "AMZN", qty: 11 },
  { ticker: "FFIV", qty: 4 }, { ticker: "NXPI", qty: 3 }, { ticker: "MBLY", qty: 228 },
  { ticker: "TSLA", qty: 6 }, { ticker: "PLTR", qty: 17 }, { ticker: "D", qty: 23 },
  { ticker: "MSFT", qty: 12 }, { ticker: "AFRM", qty: 10 }, { ticker: "BLK", qty: 2 },
  { ticker: "SOXX", qty: 6 }, { ticker: "NUE", qty: 10 }, { ticker: "CRWD", qty: 5 },
  { ticker: "GM", qty: 20 }, { ticker: "AVGO", qty: 5 }, { ticker: "ALAB", qty: 3 },
  { ticker: "ABBV", qty: 7 }, { ticker: "TKO", qty: 18 }, { ticker: "META", qty: 8 },
];

const IL_HOLDINGS = [
  { name: "קסם Nasdaq 100 KTF", ticker: "5128905", valueIls: 86794.44 },
  { name: 'קסם (4A) ETF ת"א 125', ticker: "1146356", valueIls: 12640 },
  { name: "ממשל שקלית 0432", ticker: "1180660", valueIls: 11560.9 },
  { name: "קסם (4A) ETF אינדקס", ticker: "1146430", valueIls: 5200 },
  { name: "קסם KTF MarketV", ticker: "5142088", valueIls: 4040.57 },
  { name: 'קסם (4A) ETF ת"א', ticker: "1146125", valueIls: 4847.2 },
  { name: "קסם S&P 500 KTF", ticker: "5124482", valueIls: 5318.55 },
];

const ROTATION = [
  { ticker: "TSM", allocPct: 0.25, tier: "Gold Breakout", score: 9.8 },
  { ticker: "HUM", allocPct: 0.20, tier: "Gold Breakout", score: 9.69 },
  { ticker: "GEV", allocPct: 0.20, tier: "Gold Breakout", score: 9.82 },
  { ticker: "OKTA", allocPct: 0.15, tier: "Gold Breakout", score: 9.78 },
  { ticker: "AAPL", allocPct: 0.20, tier: "Gold Retest", score: 8.5 },
];

const KEEP_TICKERS = new Set(["GM", "TKO", "NXPI"]);

function fmtUsd(n: number) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtIls(n: number) {
  return "₪" + n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function actionHe(a: string) {
  const m: Record<string, string> = {
    HOLD: "שמור", HOLD_ADD: "שמור/הוסף", TRIM: "קצץ", SELL: "מכור", NEW: "חדש (רוטציה)",
  };
  return m[a] ?? a;
}

async function analyze(ticker: string) {
  const bars = await fetchBarsForTicker(ticker, 420);
  if (!bars || bars.length < 50) return { ticker, price: 0, health: 0, action: "SELL" as const, tier: null, elzaScore: null };
  const i = bars.length - 1;
  const price = bars[i].close;
  const gs = genesisScore(bars, i);
  const intel = await getTickerIntelligence(ticker, bars);
  const sl = scoreLong(bars, i, { confluence: intel.confluenceScore, liquidity: intel.liquidityScore });
  const ziv = calcZivEngineScore(bars, ticker);
  const above200 = price > gs.ema200 && gs.ema200 > 0;
  let health = above200 ? Math.max(4, Math.min(7, ziv?.score ?? 5)) : Math.max(1, Math.min(4, ziv?.score ?? 3));
  if (gs.tier === "Gold Breakout") health = Math.min(10, gs.totalScore);
  else if (gs.tier === "Gold Retest") health = Math.min(9, gs.totalScore);
  let action: "HOLD" | "HOLD_ADD" | "TRIM" | "SELL" = "HOLD";
  if (health >= 7.5 && sl) action = "HOLD_ADD";
  else if (health >= 6 && above200) action = "HOLD";
  else if (!above200 || health < 5) action = "SELL";
  else if (health < 6) action = "TRIM";
  return {
    ticker,
    price: +price.toFixed(2),
    tier: gs.tier,
    elzaScore: gs.tier ? +gs.totalScore.toFixed(2) : null,
    health: +health.toFixed(1),
    action,
  };
}

async function main() {
  const ils = await getUsdIlsRate().catch(() => 3.6);
  const reportDate = new Date().toLocaleDateString("he-IL", { dateStyle: "long" });

  const usNow = [];
  for (const h of HOLDINGS) {
    const a = await analyze(h.ticker);
    usNow.push({
      ...h,
      ...a,
      valueUsd: +(h.qty * a.price).toFixed(2),
      decision: KEEP_TICKERS.has(h.ticker) && a.action !== "SELL" ? a.action : "SELL",
    });
    await new Promise((r) => setTimeout(r, 60));
  }
  usNow.sort((a, b) => b.valueUsd - a.valueUsd);

  const ilNow = IL_HOLDINGS.map((x) => ({
    ...x,
    valueUsd: +(x.valueIls / ils).toFixed(2),
  }));

  const usNowTotal = usNow.reduce((s, x) => s + x.valueUsd, 0);
  const ilNowTotal = ilNow.reduce((s, x) => s + x.valueUsd, 0);
  const portfolioNowTotal = usNowTotal + ilNowTotal;

  const sellList = usNow.filter((x) => x.decision === "SELL");
  const keepList = usNow.filter((x) => x.decision !== "SELL");
  const freedUsd = sellList.reduce((s, x) => s + x.valueUsd, 0);

  const usAfter = keepList.map((x) => ({ ...x, note: "נשאר" }));
  const keepSet = new Set(keepList.map((x) => x.ticker));

  for (const r of ROTATION) {
    if (keepSet.has(r.ticker)) continue;
    const bars = await fetchBarsForTicker(r.ticker, 60);
    const price = bars[bars.length - 1]?.close ?? 0;
    const budget = freedUsd * r.allocPct;
    const qty = Math.max(1, Math.floor(budget / price));
    const valueUsd = +(qty * price).toFixed(2);
    usAfter.push({
      ticker: r.ticker,
      qty,
      price: +price.toFixed(2),
      valueUsd,
      tier: r.tier,
      elzaScore: r.score,
      health: r.score,
      action: "NEW" as const,
      decision: "NEW" as const,
      note: "רוטציה ELZA",
    });
  }
  usAfter.sort((a, b) => b.valueUsd - a.valueUsd);

  const usAfterTotal = usAfter.reduce((s, x) => s + x.valueUsd, 0);
  const portfolioAfterTotal = usAfterTotal + ilNowTotal;

  const avgHealthNow =
    usNow.reduce((s, x) => s + x.health, 0) / Math.max(1, usNow.length);
  const avgHealthAfter =
    usAfter.reduce((s, x) => s + x.health, 0) / Math.max(1, usAfter.length);

  const rowsNowUs = usNow
    .map(
      (x) => `<tr>
        <td>${x.ticker}</td><td>${x.qty}</td><td>${fmtUsd(x.price)}</td>
        <td><strong>${fmtUsd(x.valueUsd)}</strong></td>
        <td>${x.health}</td><td>${x.tier ?? "—"}</td>
        <td class="${x.decision === "SELL" ? "sell" : "hold"}">${actionHe(x.decision)}</td>
      </tr>`,
    )
    .join("");

  const rowsNowIl = ilNow
    .map(
      (x) => `<tr>
        <td>${x.name}</td><td>${x.ticker}</td><td>${fmtIls(x.valueIls)}</td>
        <td><strong>${fmtUsd(x.valueUsd)}</strong></td><td colspan="3">עוגן — שמור (מחוץ ל-ELZA US)</td>
      </tr>`,
    )
    .join("");

  const rowsAfterUs = usAfter
    .map(
      (x) => `<tr>
        <td>${x.ticker}</td><td>${x.qty}</td><td>${fmtUsd(x.price)}</td>
        <td><strong>${fmtUsd(x.valueUsd)}</strong></td>
        <td>${x.health}</td><td>${x.tier ?? "—"}</td>
        <td class="${x.action === "NEW" ? "new" : "hold"}">${actionHe(x.action)}</td>
      </tr>`,
    )
    .join("");

  const rowsAfterIl = ilNow
    .map(
      (x) => `<tr>
        <td>${x.name}</td><td>${x.ticker}</td><td>${fmtIls(x.valueIls)}</td>
        <td><strong>${fmtUsd(x.valueUsd)}</strong></td><td colspan="3">ללא שינוי</td>
      </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"/>
<title>דוח תיק דרור — ELZA 4.5</title>
<style>
  @page { size: A4; margin: 18mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "DejaVu Sans", "Arial", "Helvetica", sans-serif; font-size: 11px; color: #1a1a2e; line-height: 1.45; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #0f3460; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #16213e; border-bottom: 2px solid #e94560; padding-bottom: 4px; }
  .meta { color: #555; margin-bottom: 16px; font-size: 10px; }
  .summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin: 12px 0 18px; }
  .card { background: #f8f9fc; border: 1px solid #dde3ef; border-radius: 8px; padding: 10px 12px; }
  .card strong { display: block; font-size: 16px; color: #0f3460; margin-top: 4px; }
  .card span { font-size: 10px; color: #666; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 10px; }
  th { background: #0f3460; color: #fff; padding: 6px 5px; text-align: right; }
  td { border-bottom: 1px solid #e8ecf4; padding: 5px; text-align: right; }
  tr:nth-child(even) td { background: #fafbfe; }
  .sell { color: #c0392b; font-weight: 600; }
  .hold { color: #27ae60; font-weight: 600; }
  .new { color: #2980b9; font-weight: 600; }
  .totals { background: #eef2ff; font-weight: 700; }
  .note { font-size: 9px; color: #666; margin-top: 20px; border-top: 1px solid #ddd; padding-top: 10px; }
  .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .arrow { text-align: center; font-size: 24px; color: #e94560; margin: 8px 0; }
</style>
</head>
<body>
  <h1>דוח ניתוח תיק — דרור</h1>
  <div class="meta">
    מנוע ELZA 4.5 | חשבון 133-652805 | תאריך: ${reportDate}<br/>
    שער המרה לצורך הדוח: 1 USD = ${ils.toFixed(4)} ILS | מחירים: נתוני שוק אחרונים
  </div>

  <div class="summary">
    <div class="card"><span>שווי תיק — לפני</span><strong>${fmtUsd(portfolioNowTotal)}</strong><span>US ${fmtUsd(usNowTotal)} + IL ${fmtUsd(ilNowTotal)}</span></div>
    <div class="card"><span>שווי תיק — אחרי (מומלץ)</span><strong>${fmtUsd(portfolioAfterTotal)}</strong><span>US ${fmtUsd(usAfterTotal)} + IL ${fmtUsd(ilNowTotal)}</span></div>
    <div class="card"><span>HEALTH ממוצע US</span><strong>${avgHealthNow.toFixed(1)} → ${avgHealthAfter.toFixed(1)}</strong><span>מ-${usNow.length} מניות ל-${usAfter.length}</span></div>
  </div>

  <h2>חלק א׳ — אחזקות נוכחיות (לפני שינוי)</h2>

  <h3 style="font-size:12px;margin:10px 0 4px;">מניות ארה״ב (${usNow.length} פוזיציות)</h3>
  <table>
    <thead><tr><th>טיקר</th><th>כמות</th><th>מחיר</th><th>שווי $</th><th>HEALTH</th><th>ELZA Tier</th><th>החלטה</th></tr></thead>
    <tbody>${rowsNowUs}
      <tr class="totals"><td colspan="3">סה״כ US</td><td>${fmtUsd(usNowTotal)}</td><td colspan="3">ממוצע HEALTH: ${avgHealthNow.toFixed(1)}/10</td></tr>
    </tbody>
  </table>

  <h3 style="font-size:12px;margin:10px 0 4px;">ת״א / אג״ח / קרנות (${ilNow.length} פוזיציות)</h3>
  <table>
    <thead><tr><th>שם</th><th>מזהה</th><th>שווי ₪</th><th>שווי $</th><th colspan="3">הערה</th></tr></thead>
    <tbody>${rowsNowIl}
      <tr class="totals"><td colspan="3">סה״כ IL</td><td>${fmtUsd(ilNowTotal)}</td><td colspan="3"></td></tr>
      <tr class="totals"><td colspan="3"><strong>סה״כ תיק</strong></td><td><strong>${fmtUsd(portfolioNowTotal)}</strong></td><td colspan="3">≈ ${fmtIls(portfolioNowTotal * ils)}</td></tr>
    </tbody>
  </table>

  <div class="arrow">▼</div>

  <h2>חלק ב׳ — אחזקות מומלצות (אחרי רוטציה ELZA)</h2>
  <p style="font-size:10px;color:#444;margin:0 0 8px;">
    מכירת ${sellList.length} מניות US חלשות (${fmtUsd(freedUsd)} משוחרר) → ריכוז ב-${ROTATION.length} איתותי ELZA חזקים + שמירת GM, TKO, NXPI.
    מוצרי ת״א ללא שינוי.
  </p>

  <h3 style="font-size:12px;margin:10px 0 4px;">מניות ארה״ב (${usAfter.length} פוזיציות)</h3>
  <table>
    <thead><tr><th>טיקר</th><th>כמות</th><th>מחיר</th><th>שווי $</th><th>HEALTH</th><th>ELZA Tier</th><th>סטטוס</th></tr></thead>
    <tbody>${rowsAfterUs}
      <tr class="totals"><td colspan="3">סה״כ US</td><td>${fmtUsd(usAfterTotal)}</td><td colspan="3">ממוצע HEALTH: ${avgHealthAfter.toFixed(1)}/10</td></tr>
    </tbody>
  </table>

  <h3 style="font-size:12px;margin:10px 0 4px;">ת״א / אג״ח / קרנות (ללא שינוי)</h3>
  <table>
    <thead><tr><th>שם</th><th>מזהה</th><th>שווי ₪</th><th>שווי $</th><th colspan="3">הערה</th></tr></thead>
    <tbody>${rowsAfterIl}
      <tr class="totals"><td colspan="3">סה״כ IL</td><td>${fmtUsd(ilNowTotal)}</td><td colspan="3"></td></tr>
      <tr class="totals"><td colspan="3"><strong>סה״כ תיק</strong></td><td><strong>${fmtUsd(portfolioAfterTotal)}</strong></td><td colspan="3">≈ ${fmtIls(portfolioAfterTotal * ils)}</td></tr>
    </tbody>
  </table>

  <h2>סיכום השינוי</h2>
  <div class="compare">
    <div class="card">
      <span>לפני</span>
      <strong>${usNow.length} מניות US</strong>
      <span>פיזור רחב, HEALTH נמוך (${avgHealthNow.toFixed(1)})</span>
    </div>
    <div class="card">
      <span>אחרי</span>
      <strong>${usAfter.length} מניות US</strong>
      <span>ריכוז באיתותי Gold Breakout/Retest, HEALTH ${avgHealthAfter.toFixed(1)}</span>
    </div>
  </div>

  <div class="note">
    <strong>הבהרות:</strong> דוח זה נוצר לצורכי ניתוח read-only על בסיס מנוע ELZA 4.5 (War Room).
    אינו המלצת השקעה מחייבת. כמויות "אחרי" מחושבות פרופורציונלית לתקציב המשוחרר ממכירות.
    מוצרי ת״א/אג״ח נשמרים כעוגן יציבות. מסחר בפועל כפוף לרג׳ים מאקרו (SPY/EMA-50) ולמגבלות ELZA Live.
    <br/>TRADE-SNOW2.VIP | ELZA 4.5
  </div>
</body>
</html>`;

  const outDir = join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, "dror-elza-portfolio-report.html");
  const pdfPath = join(outDir, "dror-elza-portfolio-report.pdf");
  writeFileSync(htmlPath, html, "utf8");

  execSync(
    `google-chrome --headless --disable-gpu --no-sandbox --print-to-pdf="${pdfPath}" "file://${htmlPath}" 2>/dev/null`,
    { stdio: "inherit" },
  );

  console.log("PDF:", pdfPath);
  console.log("HTML:", htmlPath);
  console.log("Portfolio before:", fmtUsd(portfolioNowTotal), "| after:", fmtUsd(portfolioAfterTotal));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

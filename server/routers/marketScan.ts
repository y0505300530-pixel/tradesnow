/**
 * Market Scan — 5 Strategy SSE Streaming Route
 * POST /api/market-scan
 *
 * Streams real-time progress (0-100%) while scanning tickers.
 * Returns top-10 results per scan, excluding tickers already in the user's catalogue.
 *
 * Scan strategies:
 *   1. finviz   — Non-Tech sectors, RSI 40-60, Volume >500K, momentum (EMA cross + near high)
 *   2. tvscreen — EMA50 > EMA200, RSI 50-70, low ATR volatility, orderly uptrend
 *   3. whale    — Institutional quality stocks (Berkshire / top fund holdings overlap)
 *   4. ibd      — IBD RS-style: Relative Strength vs SPY >85th pct, near 52-week high
 *   5. sector   — Sector Rotation: leading sector last 30 days → top stocks per sector
 */

import { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { getUserAssets } from "../db";
import { fetchBarsForTicker } from "../marketData";
import { calcEMA, calcRSI, calcZivEngineScore, type Bar } from "../zivEngine";

// ─── Ticker Universes ─────────────────────────────────────────────────────────

const SECTOR_MAP: Record<string, string> = {
  // Healthcare
  "UNH":"Healthcare","LLY":"Pharma","JNJ":"Pharma","ABBV":"Pharma","MRK":"Pharma",
  "AMGN":"Biotech","GILD":"Biotech","REGN":"Biotech","VRTX":"Biotech","BMY":"Pharma",
  "PFE":"Pharma","ISRG":"Healthcare","BSX":"Healthcare","MDT":"Healthcare","ABT":"Healthcare",
  "TMO":"Healthcare","DHR":"Healthcare","SYK":"Healthcare","ELV":"Healthcare","CI":"Healthcare",
  // Finance
  "JPM":"Finance","GS":"Finance","MS":"Finance","BAC":"Finance","WFC":"Finance",
  "BLK":"Finance","SCHW":"Finance","AXP":"Finance","COF":"Finance","USB":"Finance",
  "PNC":"Finance","TFC":"Finance","SPGI":"Finance","MCO":"Finance","ICE":"Finance",
  // Payments
  "V":"Payments","MA":"Payments","PYPL":"Payments","SQ":"Payments","FIS":"Payments",
  // Energy
  "XOM":"Oil & Gas","CVX":"Oil & Gas","COP":"Oil & Gas","SLB":"Oil Services","EOG":"Oil & Gas",
  "MPC":"Oil Refining","PSX":"Oil Refining","VLO":"Oil Refining","OXY":"Oil & Gas","HAL":"Oil Services",
  "DVN":"Oil & Gas","FANG":"Oil & Gas","LNG":"Natural Gas","KMI":"Midstream","WMB":"Midstream",
  // Industrials
  "CAT":"Industrials","GE":"Industrials","DE":"Industrials","HON":"Industrials","MMM":"Industrials",
  "RTX":"Defense","LMT":"Defense","NOC":"Defense","GD":"Defense","BA":"Aerospace",
  "UPS":"Logistics","FDX":"Logistics","CSX":"Transport","NSC":"Transport","UNP":"Transport",
  "AXON":"Defense","KTOS":"Defense","LDOS":"Defense",
  // Consumer Discretionary
  "AMZN":"E-Commerce","TSLA":"EV","HD":"Retail","LOW":"Retail","TGT":"Retail",
  "NKE":"Consumer","SBUX":"Consumer","MCD":"Consumer","CMG":"Consumer","BKNG":"Travel",
  "MAR":"Travel","HLT":"Travel","ABNB":"Travel","UBER":"Rideshare","LYFT":"Rideshare",
  // Consumer Staples
  "WMT":"Staples","COST":"Staples","PG":"Staples","KO":"Staples","PEP":"Staples",
  "PM":"Staples","MO":"Staples","CL":"Staples","GIS":"Staples","K":"Staples",
  // Materials / Mining
  "FCX":"Copper Mining","SCCO":"Copper Mining","CLF":"Steel","NUE":"Steel","AA":"Aluminum",
  "GOLD":"Gold Mining","NEM":"Gold Mining","AEM":"Gold Mining","WPM":"Silver Mining",
  // Utilities
  "NEE":"Utilities","DUK":"Utilities","SO":"Utilities","AEP":"Utilities","D":"Utilities",
  "EXC":"Utilities","PCG":"Utilities","ED":"Utilities","XEL":"Utilities",
  // Real Estate
  "PLD":"REIT","AMT":"REIT","EQIX":"REIT","CCI":"REIT","SPG":"REIT","O":"REIT",
  // Crypto / Fintech
  "COIN":"Crypto","MSTR":"Crypto","HOOD":"Fintech","SOFI":"Fintech","NU":"Fintech",
  // Tech (for whale/ibd scans only)
  "AAPL":"Tech","MSFT":"Tech","NVDA":"Semiconductors","GOOGL":"Tech",
  "META":"Tech","AVGO":"Semiconductors","ORCL":"Tech","NFLX":"Media",
  "AMD":"Semiconductors","QCOM":"Semiconductors","MU":"Semiconductors",
  "CRM":"SaaS","NOW":"SaaS","SNOW":"SaaS","PLTR":"SaaS","DDOG":"SaaS",
  "CRWD":"Cybersecurity","ZS":"Cybersecurity","PANW":"Cybersecurity","NET":"Cybersecurity",
};

// Scan 1: Finviz-style — non-Tech sectors only
const FINVIZ_UNIVERSE = Object.entries(SECTOR_MAP)
  .filter(([, s]) => !["Tech","SaaS","Cybersecurity","Semiconductors","Media"].includes(s))
  .map(([t]) => t);

// Scan 2: TradingView Screener — broad universe
const TV_UNIVERSE = Object.keys(SECTOR_MAP);

// Scan 3: Whale Wisdom — top institutional holdings (Berkshire + top hedge funds)
const WHALE_UNIVERSE = [
  // Berkshire Hathaway top holdings
  "AAPL","BAC","AXP","KO","CVX","OXY","MCO","KHC","USB","DVA",
  // Bridgewater Associates
  "SPY","GLD","EEM","VWO","IVV","LQD","TLT","GDX","IAU","IEMG",
  // Pershing Square (Bill Ackman)
  "HLT","CMG","GOOGL","LBRDK","QSR","HHH",
  // Appaloosa (David Tepper)
  "NVDA","META","AMZN","GOOGL","MSFT","UBER","BABA",
  // Tiger Global
  "MSFT","AMZN","META","GOOGL","NFLX","CRM","NOW","SNOW",
  // Coatue Management
  "NVDA","TSLA","AMZN","META","MSFT","AAPL","GOOGL","NFLX",
  // Druckenmiller
  "NVDA","MSFT","AMZN","GOOGL","META","V","MA","UNH",
].filter((t, i, a) => a.indexOf(t) === i); // deduplicate

// Scan 4: IBD RS-style — quality growth stocks
const IBD_UNIVERSE = [
  "NVDA","AAPL","MSFT","META","GOOGL","AMZN","TSLA","AVGO","ORCL","NFLX",
  "AMD","QCOM","AMAT","LRCX","KLAC","MU","MRVL","ARM","SMCI","TSM",
  "CRM","NOW","SNOW","PLTR","DDOG","CRWD","ZS","PANW","NET","FTNT",
  "LLY","UNH","ISRG","REGN","VRTX","AMGN","ABBV","TMO","DHR","BSX",
  "V","MA","JPM","GS","BLK","SPGI","MCO","AXP","COF","ICE",
  "CAT","DE","HON","GE","AXON","KTOS","LMT","RTX","NOC","LDOS",
  "COST","WMT","HD","LOW","NKE","SBUX","MCD","CMG","BKNG","ABNB",
  "XOM","CVX","COP","EOG","OXY","LNG","WMB","KMI","SLB","HAL",
  "FCX","SCCO","NEM","GOLD","WPM","CLF","NUE","AA",
  "COIN","MSTR","HOOD","SOFI","NU","PYPL","SQ","FIS",
  "UBER","LYFT","RDDT","SNAP","SPOT","DIS",
];

// Scan 5: Sector Rotation — sector ETFs + their top components
const SECTOR_ETFS: Record<string, { etf: string; stocks: string[] }> = {
  "Technology":   { etf: "XLK", stocks: ["AAPL","MSFT","NVDA","AVGO","ORCL","AMD","QCOM","ACN","IBM","TXN"] },
  "Healthcare":   { etf: "XLV", stocks: ["UNH","LLY","JNJ","ABBV","MRK","TMO","ABT","DHR","ISRG","BSX"] },
  "Financials":   { etf: "XLF", stocks: ["JPM","BAC","WFC","GS","MS","BLK","SCHW","AXP","SPGI","MCO"] },
  "Energy":       { etf: "XLE", stocks: ["XOM","CVX","COP","EOG","SLB","OXY","MPC","VLO","PSX","HAL"] },
  "Industrials":  { etf: "XLI", stocks: ["CAT","GE","HON","DE","RTX","LMT","UPS","FDX","CSX","UNP"] },
  "Consumer Disc":{ etf: "XLY", stocks: ["AMZN","TSLA","HD","LOW","NKE","SBUX","MCD","CMG","BKNG","TJX"] },
  "Materials":    { etf: "XLB", stocks: ["LIN","APD","SHW","FCX","NEM","NUE","ALB","ECL","PPG","VMC"] },
  "Utilities":    { etf: "XLU", stocks: ["NEE","DUK","SO","AEP","D","EXC","PCG","ED","XEL","AWK"] },
  "Real Estate":  { etf: "XLRE", stocks: ["PLD","AMT","EQIX","CCI","SPG","O","WELL","DLR","PSA","EQR"] },
  "Comm Services":{ etf: "XLC", stocks: ["META","GOOGL","NFLX","DIS","CMCSA","T","VZ","TMUS","SNAP","RDDT"] },
  "Staples":      { etf: "XLP", stocks: ["WMT","COST","PG","KO","PEP","PM","MO","CL","GIS","MDLZ"] },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcATR(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calcVolatilityScore(bars: Bar[]): number {
  // Lower is better — returns normalised ATR as % of price
  const atr = calcATR(bars);
  const lastClose = bars[bars.length - 1]?.close ?? 1;
  return (atr / lastClose) * 100;
}

function calcRelativeStrength(stockBars: Bar[], spyBars: Bar[]): number {
  // RS = (stock 3-month return) / (SPY 3-month return)
  const months3 = 63;
  if (stockBars.length < months3 || spyBars.length < months3) return 0;
  const stockReturn = (stockBars[stockBars.length - 1].close - stockBars[stockBars.length - months3].close) / stockBars[stockBars.length - months3].close;
  const spyReturn = (spyBars[spyBars.length - 1].close - spyBars[spyBars.length - months3].close) / spyBars[spyBars.length - months3].close;
  if (spyReturn === 0) return 0;
  return stockReturn / Math.abs(spyReturn);
}

function calc52WeekHighProximity(bars: Bar[]): number {
  const year = bars.slice(-252);
  const high52 = Math.max(...year.map(b => b.high));
  const lastClose = bars[bars.length - 1]?.close ?? 0;
  return high52 > 0 ? (lastClose / high52) * 100 : 0;
}

function calcAvgVolume(bars: Bar[], days = 20): number {
  const recent = bars.slice(-days);
  if (recent.length === 0) return 0;
  return recent.reduce((s, b) => s + (b.volume ?? 0), 0) / recent.length;
}

function buildScanResult(ticker: string, bars: Bar[], extraScore?: number) {
  const ziv = calcZivEngineScore(bars);
  const score = extraScore != null ? Math.min(10, (ziv.score + extraScore) / 2) : ziv.score;
  const closes = bars.map(b => b.close);
  const ema50 = calcEMA(closes, 50);
  const lastClose = closes[closes.length - 1] ?? 0;
  const slPct = 0.08;
  const sl = Math.max(lastClose * (1 - slPct), ema50 * 0.97);
  const tp = lastClose + 2.5 * (lastClose - sl);
  return {
    ticker,
    companyName: ticker,
    score: Math.round(score * 100) / 100,
    tier: ziv.tier,
    reason: ziv.priceAction ?? "",
    meetsEntry: score >= 7,
    entryZone: `$${(lastClose * 0.99).toFixed(2)} – $${(lastClose * 1.01).toFixed(2)}`,
    stopLoss: `$${sl.toFixed(2)}`,
    takeProfit: `$${tp.toFixed(2)}`,
    price: lastClose,
    sector: SECTOR_MAP[ticker] ?? "Other",
    volume: calcAvgVolume(bars),
  };
}

// ─── Scan Implementations ─────────────────────────────────────────────────────

async function scanFinviz(universe: string[], send: (p: number, msg: string) => void): Promise<ReturnType<typeof buildScanResult>[]> {
  const results: ReturnType<typeof buildScanResult>[] = [];
  for (let i = 0; i < universe.length; i++) {
    const ticker = universe[i];
    send(Math.round((i / universe.length) * 100), `Finviz: סורק ${ticker} (${i + 1}/${universe.length})`);
    try {
      const bars = await fetchBarsForTicker(ticker, 300);
      if (bars.length < 60) continue;
      const closes = bars.map(b => b.close);
      const rsi = calcRSI(closes);
      const ema50 = calcEMA(closes, 50);
      const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);
      const lastClose = closes[closes.length - 1] ?? 0;
      const avgVol = calcAvgVolume(bars);
      const near52High = calc52WeekHighProximity(bars);
      // Finviz criteria: RSI 40-60, EMA cross, volume >500K, near high
      if (rsi < 40 || rsi > 65) continue;
      if (lastClose < ema50) continue;
      if (ema50 < ema200 * 0.99) continue;
      if (avgVol < 500_000) continue;
      if (near52High < 75) continue; // within 25% of 52-week high
      results.push(buildScanResult(ticker, bars));
    } catch { continue; }
  }
  return results;
}

async function scanTVScreener(universe: string[], send: (p: number, msg: string) => void): Promise<ReturnType<typeof buildScanResult>[]> {
  const results: ReturnType<typeof buildScanResult>[] = [];
  for (let i = 0; i < universe.length; i++) {
    const ticker = universe[i];
    send(Math.round((i / universe.length) * 100), `TradingView: סורק ${ticker} (${i + 1}/${universe.length})`);
    try {
      const bars = await fetchBarsForTicker(ticker, 300);
      if (bars.length < 60) continue;
      const closes = bars.map(b => b.close);
      const rsi = calcRSI(closes);
      const ema50 = calcEMA(closes, 50);
      const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);
      const lastClose = closes[closes.length - 1] ?? 0;
      const volPct = calcVolatilityScore(bars);
      // TradingView criteria: EMA50>EMA200, RSI 50-70, low volatility (<4%), orderly
      if (ema50 <= ema200) continue;
      if (rsi < 50 || rsi > 72) continue;
      if (volPct > 4.5) continue; // filter wild movers
      if (lastClose < ema50 * 0.97) continue;
      results.push(buildScanResult(ticker, bars));
    } catch { continue; }
  }
  return results;
}

async function scanWhale(universe: string[], send: (p: number, msg: string) => void): Promise<ReturnType<typeof buildScanResult>[]> {
  const results: ReturnType<typeof buildScanResult>[] = [];
  for (let i = 0; i < universe.length; i++) {
    const ticker = universe[i];
    send(Math.round((i / universe.length) * 100), `Whale Wisdom: בודק ${ticker} (${i + 1}/${universe.length})`);
    try {
      const bars = await fetchBarsForTicker(ticker, 300);
      if (bars.length < 60) continue;
      const closes = bars.map(b => b.close);
      const ema50 = calcEMA(closes, 50);
      const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);
      const lastClose = closes[closes.length - 1] ?? 0;
      // Whale criteria: above both EMAs (institutions hold quality), decent trend
      if (lastClose < ema200 * 0.98) continue;
      if (ema50 < ema200 * 0.97) continue;
      results.push(buildScanResult(ticker, bars, 1)); // +1 bonus for institutional quality
    } catch { continue; }
  }
  return results;
}

async function scanIBD(universe: string[], spyBars: Bar[], send: (p: number, msg: string) => void): Promise<ReturnType<typeof buildScanResult>[]> {
  const results: ReturnType<typeof buildScanResult>[] = [];
  for (let i = 0; i < universe.length; i++) {
    const ticker = universe[i];
    send(Math.round((i / universe.length) * 100), `IBD RS: מחשב ${ticker} (${i + 1}/${universe.length})`);
    try {
      const bars = await fetchBarsForTicker(ticker, 300);
      if (bars.length < 63) continue;
      const closes = bars.map(b => b.close);
      const ema50 = calcEMA(closes, 50);
      const lastClose = closes[closes.length - 1] ?? 0;
      const rs = calcRelativeStrength(bars, spyBars);
      const near52High = calc52WeekHighProximity(bars);
      // IBD criteria: RS > 1.2 (outperforming SPY by 20%+), near 52-week high, above EMA50
      if (rs < 1.2) continue;
      if (near52High < 80) continue;
      if (lastClose < ema50 * 0.96) continue;
      // RS bonus: stronger outperformers get higher score
      const rsBonus = Math.min(2, (rs - 1.2) * 5);
      results.push(buildScanResult(ticker, bars, rsBonus));
    } catch { continue; }
  }
  return results;
}

async function scanSectorRotation(excludeSet: Set<string>, send: (p: number, msg: string) => void): Promise<ReturnType<typeof buildScanResult>[]> {
  const sectorNames = Object.keys(SECTOR_ETFS);
  const sectorReturns: { name: string; return30d: number; stocks: string[] }[] = [];

  // Step 1: Fetch ETF returns to find leading sector
  send(5, "Sector Rotation: טוען ביצועי סקטורים...");
  for (const sectorName of sectorNames) {
    try {
      const { etf, stocks } = SECTOR_ETFS[sectorName];
      const bars = await fetchBarsForTicker(etf, 60);
      if (bars.length < 30) continue;
      const ret30d = (bars[bars.length - 1].close - bars[bars.length - 30].close) / bars[bars.length - 30].close * 100;
      sectorReturns.push({ name: sectorName, return30d: ret30d, stocks });
    } catch { continue; }
  }

  // Sort sectors by 30-day return, take top 3
  sectorReturns.sort((a, b) => b.return30d - a.return30d);
  const topSectors = sectorReturns.slice(0, 3);

  send(20, `Sector Rotation: סקטורים מובילים — ${topSectors.map(s => s.name).join(", ")}`);

  // Step 2: Scan top stocks in leading sectors
  const results: ReturnType<typeof buildScanResult>[] = [];
  const allStocks = topSectors.flatMap(s => s.stocks.map(t => ({ ticker: t, sector: s.name, sectorReturn: s.return30d })));

  for (let i = 0; i < allStocks.length; i++) {
    const { ticker, sector, sectorReturn } = allStocks[i];
    if (excludeSet.has(ticker.toUpperCase())) continue;
    send(20 + Math.round((i / allStocks.length) * 75), `Sector Rotation: ${sector} — ${ticker} (${i + 1}/${allStocks.length})`);
    try {
      const bars = await fetchBarsForTicker(ticker, 300);
      if (bars.length < 60) continue;
      const closes = bars.map(b => b.close);
      const ema50 = calcEMA(closes, 50);
      const lastClose = closes[closes.length - 1] ?? 0;
      if (lastClose < ema50 * 0.95) continue; // must be near or above EMA50
      // Sector momentum bonus
      const sectorBonus = Math.min(1.5, sectorReturn / 10);
      const result = buildScanResult(ticker, bars, sectorBonus);
      result.sector = sector;
      results.push(result);
    } catch { continue; }
  }
  return results;
}

// ─── Register SSE Route ───────────────────────────────────────────────────────

export function registerMarketScanRoute(app: Express): void {
  app.post("/api/market-scan", async (req: Request, res: Response) => {
    // Auth
    let userId: number;
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Unauthorized" }); return;
    }

    const scanType: string = req.body?.scanType ?? "finviz";
    const topN: number = Math.min(10, parseInt(req.body?.topN ?? "10", 10));

    // Get user's existing catalogue to exclude
    const userAssets = await getUserAssets(userId);
    const excludeSet = new Set(userAssets.map((a: { ticker: string }) => a.ticker.toUpperCase()));

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (progress: number, message: string, results?: unknown) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ progress, message, results })}\n\n`);
      }
    };

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
      else clearInterval(heartbeat);
    }, 15_000);

    req.on("close", () => clearInterval(heartbeat));

    try {
      send(0, "מתחיל סריקה...");

      let rawResults: ReturnType<typeof buildScanResult>[] = [];

      if (scanType === "finviz") {
        const universe = FINVIZ_UNIVERSE.filter(t => !excludeSet.has(t.toUpperCase()));
        rawResults = await scanFinviz(universe, send);

      } else if (scanType === "tvscreen") {
        const universe = TV_UNIVERSE.filter(t => !excludeSet.has(t.toUpperCase()));
        rawResults = await scanTVScreener(universe, send);

      } else if (scanType === "whale") {
        const universe = WHALE_UNIVERSE.filter(t => !excludeSet.has(t.toUpperCase()));
        rawResults = await scanWhale(universe, send);

      } else if (scanType === "ibd") {
        send(2, "IBD RS: טוען נתוני SPY...");
        let spyBars: Bar[] = [];
        try { spyBars = await fetchBarsForTicker("SPY", 300); } catch { /* ignore */ }
        const universe = IBD_UNIVERSE.filter(t => !excludeSet.has(t.toUpperCase()));
        rawResults = await scanIBD(universe, spyBars, send);

      } else if (scanType === "sector") {
        rawResults = await scanSectorRotation(excludeSet, send);
      }

      // Filter score >= 7, sort by score desc, take top N
      const filtered = rawResults
        .filter(r => r.score >= 7)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

      send(100, `סריקה הושלמה — נמצאו ${filtered.length} נכסים עם ציון ≥7`, filtered);

    } catch (err: any) {
      send(100, `שגיאה בסריקה: ${err?.message ?? "Unknown error"}`, []);
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });
}

/**
 * Price Alert Poller
 * Runs every 5 minutes on the server. Checks all active (untriggered) price alerts
 * for all users, fetches live prices, and sends Telegram notifications when SL/TP is hit.
 *
 * ── Alert Firewall Rules ──────────────────────────────────────────────────────
 * 1. "No Ziv, No Talk": alerts without a zivScore (null) are silently archived.
 * 2. Pre-Flight Filter: only alerts with zivScore >= 8.0 trigger Telegram.
 *    Sub-8 alerts are marked triggered but immediately archived (no Telegram).
 * 3. Anti-Spam 24h Dedup: a ticker can only send ONE Telegram message per 24h.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync as fsExistsSync } from "fs";
import http from "http";
import { calcBearScore, calcShortSL } from "./shortEngine";
import { getDb, getUserByOpenId, getSystemSetting, setSystemSetting, upsertPortfolioSnapshot, getTodaySnapshot, getUserAssets, updateUserAssetScore } from "./db";
import { sql } from "drizzle-orm";
import { userSettings, portfolioHoldings, userAssets, holding2 } from "../drizzle/schema";
import { eq, and, isNull, inArray, isNotNull, desc } from "drizzle-orm";
import { fetchLivePricesBatch, fetchIbkrLivePricesBatch, getUsdIlsRate, normalizeTickerSymbol, fetchBarsForTicker, fetchLivePrice } from "./marketData";
import { normalizeBarsForTicker } from "./services/PriceService";
import { sendTelegramMessage, formatAlertMessage } from "./telegram";
import { runCorporateActionSync }    from "./corporateActionSync";
import { runPartialFillMonitor, runHaltRecoveryMonitor } from "./partialFillMonitor";
import { setProgress } from "./warRoomProgress";

// ── Daily signal counters (in-memory, resets on deploy/day) ──
let _longSignalDayKey = "";
let _longSignalCount = 0;   // USA: max 5/day (16:30–23:00 IL)
let _taseSignalDayKey = "";
let _taseSignalCount = 0;   // TASE: max 3/day (10:00–17:30 IL, Sun–Thu)
import { ENV } from "./_core/env";
import { ibindCached } from "./ibkrCache";
import { isUsClosed, isTaseClosed, getExchange, isUsOpen, isTaseOpen, isIbkrSyncMarketOpen } from "./utils/marketHours";

import { refreshKronosCatalogueBatch } from "./kronosCatalogueRefresh";
import { calcZivEngineScore } from "./zivEngine";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ZIV_SCORE_THRESHOLD = 8.0;     // Minimum Ziv score for BUY alerts + firewall gate (SL/TP/Near Entry)
const ZIV_BREAKOUT_THRESHOLD = 6.5;  // Lower threshold for Breakout/Retest alerts (momentum context)
/** Absolute Trash-Tier floor — score < 4.0 is ALWAYS silently archived, never sent to Telegram */
const ZIV_TRASH_FLOOR = 4.0;
const ANTI_SPAM_MS = 24 * 60 * 60 * 1000; // 24 hours

// Anti-spam for unified hotSignal BUY alerts is now DB-backed (userAssets.lastSignalSentAt)


/**
 * Send a daily portfolio summary to Telegram at 09:00 (Israel time, UTC+3)
 * Format: total portfolio summary + top 3 gainers + top 3 losers
 * Dedup: DB-persisted key prevents duplicate sends across server restarts
 */
// ── Helper: sleep ────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Helper: format a portfolio group summary message ─────────────────────────
interface GroupStat {
  ticker: string;
  unrealizedPnl: number;  // All-Time P&L since buy price
  pnlPct: number;         // All-Time P&L % since buy price
  todayPnl: number;       // Today P&L (daily change in $)
  todayPct: number;       // Today P&L % (daily change %)
  value: number;          // current market value
  cost: number;           // cost basis
}

// ── Helper: format $ with sign ──────────────────────────────────────────────
const fmtUsd = (n: number, decimals = 0) =>
  `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: decimals })}`;
const fmtPct = (n: number, decimals = 2) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}%`;

function buildGroupMessage(
  title: string,
  emoji: string,
  stats: GroupStat[],
  dateStr: string,
  ilsRate?: number
): string {
  const totalValue = stats.reduce((s, x) => s + x.value, 0);
  const totalCost  = stats.reduce((s, x) => s + x.cost, 0);
  const totalAllTimePnl = stats.reduce((s, x) => s + x.unrealizedPnl, 0);
  const totalAllTimePct = totalCost > 0 ? (totalAllTimePnl / totalCost) * 100 : 0;
  const totalTodayPnl   = stats.reduce((s, x) => s + x.todayPnl, 0);
  const totalTodayPct   = totalCost > 0 ? (totalTodayPnl / totalCost) * 100 : 0;

  // ── Header ────────────────────────────────────────────────────────────
  const parts: string[] = [
    `${emoji} <b>trade-snow2.vip — ${title}</b>`,
    `<i>${dateStr}</i>`,
    ``,
  ];

  // ── Summary card ───────────────────────────────────────────────────────────
  // Value $ and ILS (only for All Accounts)
  if (ilsRate && ilsRate > 0) {
    const ilsValue = totalValue * ilsRate;
    parts.push(`💰 <b>$${totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b>   <b>₪${ilsValue.toLocaleString("he-IL", { maximumFractionDigits: 0 })}</b>`);
  } else {
    parts.push(`💰 <b>$${totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b>`);
  }
  parts.push(`   פוזיציות: ${stats.length}`);
  parts.push(``);

  // Today row
  const todayEmoji = totalTodayPnl >= 0 ? "🟢" : "🔴";
  const todayIlsStr = (ilsRate && ilsRate > 0)
    ? `  (₪${Math.round(totalTodayPnl * ilsRate).toLocaleString("he-IL")})`
    : "";
  parts.push(`${todayEmoji} <b>Today</b>   ${fmtPct(totalTodayPct)}   ${fmtUsd(totalTodayPnl)}${todayIlsStr}`);

  // All-Time row
  const atEmoji = totalAllTimePnl >= 0 ? "✅" : "⚠️";
  parts.push(`${atEmoji} <b>All-Time</b>   ${fmtPct(totalAllTimePct)}   ${fmtUsd(totalAllTimePnl)}`);
  parts.push(``);

  // ── Per-position table (sorted by All-Time P&L% descending) ─────────────────
  const sorted = [...stats].sort((a, b) => b.pnlPct - a.pnlPct);

  // Header row
  parts.push(`<code>Ticker     Today%   All-Time%</code>`);
  parts.push(`<code>─────────────────────────────</code>`);

  for (const s of sorted) {
    const atSign  = s.pnlPct >= 0 ? "+" : "";
    const todSign = s.todayPct >= 0 ? "+" : "";
    const rowEmoji = s.pnlPct >= 0 ? "🟢" : "🔴";
    const ticker = s.ticker.slice(0, 9).padEnd(9);
    const today  = `${todSign}${s.todayPct.toFixed(1)}%`.padStart(7).slice(-7);
    const at     = `${atSign}${s.pnlPct.toFixed(1)}%`.padStart(9).slice(-9);
    parts.push(`${rowEmoji}<code>${ticker} ${today}   ${at}</code>`);
  }

  return parts.join("\n");
}

/**
 * Send a daily portfolio summary to Telegram at 09:00 (Israel time, UTC+3)
 * Sends 4 separate messages: Holding 1, H2 TASE, H2 USA, All Accounts (with ILS)
 * All data from IBKR — NO Yahoo Finance for owner's portfolios.
 * Dedup: DB-persisted key prevents duplicate sends across server restarts.
 */
async function runDailySummary() {
  if (!BOT_TOKEN || !OWNER_CHAT_ID) return;
  try {
    const db = await getDb();
    if (!db) return;

    // ── DB-based dedup: check if we already sent today ──────────────────────
    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastSentKey = await getSystemSetting("daily_summary_last_sent");
    if (lastSentKey === todayKey) {
      console.log(`[AlertPoller] Daily summary already sent today (${todayKey}) — skipping`);
      return;
    }
    // Mark as sent immediately to prevent race conditions
    await setSystemSetting("daily_summary_last_sent", todayKey);

    // OWNER ONLY: resolve owner userId from OWNER_OPEN_ID
    let ownerUserId: number | null = null;
    if (ENV.ownerOpenId) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      ownerUserId = ownerUser?.id ?? null;
    }
    if (ownerUserId == null) {
      console.warn("[AlertPoller] OWNER_OPEN_ID not set — falling back to userId=1");
      ownerUserId = 1;
    }
    const chatId = OWNER_CHAT_ID!;
    const dateStr = new Date().toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long" });

    // ── USD/ILS rate (for All Accounts message) ──────────────────────────────
    let ilsRate = 3.60;
    try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }

    // ════════════════════════════════════════════════════════════════════════
    // MESSAGE 1: Holding 1 (portfolioHoldings — IBKR)
    // ════════════════════════════════════════════════════════════════════════
    const h1Stats: GroupStat[] = [];
    let h1TotalValue = 0;
    let h1TotalPnl = 0;
    try {
      const allH1 = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId));
      const h1Holdings = allH1.filter((h: { units: number }) => h.units !== 0);

      if (h1Holdings.length > 0) {
        // Fetch IBKR /positions for per-ticker unrealizedPnl
        // Sequential calls with delay to avoid IBIND rate limit
        const posRes = await ibindCached("GET", "/positions");
        await sleep(350);
        const posMap = new Map<string, number>(); // ticker → unrealizedPnl
        const mktValueMap = new Map<string, number>(); // ticker → mktValue
        if (posRes.ok && posRes.body) {
          const posRaw = posRes.body as Record<string, any>;
          const positions: any[] = posRaw.positions ?? (Array.isArray(posRaw) ? posRaw : []);
          for (const p of positions) {
            const sym = (
              p.ticker ?? p.symbol ?? p.localSymbol ?? p.local_symbol ??
              p.contractDesc ?? p.contract_desc ?? p.contract?.symbol ??
              p.name ?? p.description ?? ""
            ).toUpperCase().replace(/\s+.*$/, "");
            if (sym) {
              posMap.set(sym, p.unrealizedPnl ?? p.unrealized_pnl ?? p.pnl ?? 0);
              mktValueMap.set(sym, p.mktValue ?? p.market_value ?? p.value ?? 0);
            }
          }
        }

        for (const h of h1Holdings) {
          const sym = h.ticker.toUpperCase();
          const unrealizedPnl = posMap.get(sym) ?? h.ibkrUnrealizedPnl ?? 0;
          // Market value from IBKR /positions if available, else estimate from DB
          const mktValue = (mktValueMap.get(sym) ?? 0) > 0
            ? mktValueMap.get(sym)!
            : (h.currentPrice ?? h.buyPrice) * h.units;
          const cost = h.buyPrice * h.units;  // cost basis = buyPrice × units
          const pnlPct = cost > 0 ? (unrealizedPnl / cost) * 100 : 0;
          // Today P&L: use prevClose-based calculation (IBKR unrealizedPnl is All-Time)
          const prevClose = h.currentPrice ?? h.buyPrice;
          const dailyChangePct = h.dailyChangePercent ?? 0;
          const todayPnl = dailyChangePct !== 0
            ? mktValue - (mktValue / (1 + dailyChangePct / 100))
            : 0;
          const todayPct = cost > 0 ? (todayPnl / cost) * 100 : 0;

          h1Stats.push({ ticker: h.ticker, unrealizedPnl, pnlPct, todayPnl, todayPct, value: mktValue, cost });
          h1TotalValue += mktValue;
          h1TotalPnl += unrealizedPnl;
        }

        const h1Msg = buildGroupMessage("Holding 1 (IBKR)", "📊", h1Stats, dateStr);
        await sendTelegramMessage(h1Msg, chatId);
        console.log(`[AlertPoller] Daily summary H1 sent (${h1Holdings.length} positions)`);
        await sleep(500);
      }
    } catch (err) {
      console.warn("[AlertPoller] Error building H1 daily summary:", err);
    }

    // ════════════════════════════════════════════════════════════════════════
    // MESSAGES 2 & 3: H2 TASE + H2 USA (holding2 table — IBKR prices)
    // ════════════════════════════════════════════════════════════════════════
    const h2TaseStats: GroupStat[] = [];
    const h2UsaStats: GroupStat[] = [];
    const h2CryptoStats: GroupStat[] = [];
    let h2TotalValue = 0;
    let h2TotalPnl = 0;
    try {
      const allH2 = await db.select().from(holding2).where(eq(holding2.userId, ownerUserId));
      const h2Holdings = allH2.filter((h: { units: number }) => h.units !== 0);

      if (h2Holdings.length > 0) {
        const h2Tickers = h2Holdings.map((h: { ticker: string }) => h.ticker);
        // Use IBKR prices for H2 (no Yahoo Finance)
        const h2PricesMap = await fetchIbkrLivePricesBatch(h2Tickers);

        for (const h of h2Holdings) {
          const sym = h.ticker.toUpperCase();
          const lp = h2PricesMap.get(h.ticker) ?? h2PricesMap.get(sym);
          const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
          const mktValue = price * h.units;
          const cost = h.buyPrice * h.units;
          const unrealizedPnl = mktValue - cost;  // All-Time P&L
          const pnlPct = cost > 0 ? (unrealizedPnl / cost) * 100 : 0;
          // Today P&L: use changePercent from IBKR live price
          const dailyChangePct = lp?.changePercent ?? h.dailyChangePercent ?? 0;
          const todayPnl = dailyChangePct !== 0
            ? mktValue - (mktValue / (1 + dailyChangePct / 100))
            : 0;
          const todayPct = cost > 0 ? (todayPnl / cost) * 100 : 0;

          const stat: GroupStat = { ticker: h.ticker, unrealizedPnl, pnlPct, todayPnl, todayPct, value: mktValue, cost };
          h2TotalValue += mktValue;
          h2TotalPnl += unrealizedPnl;

          // Separate by suffix: .TA = TASE, -USD = Crypto, rest = USA
          if (sym.endsWith(".TA")) {
            h2TaseStats.push(stat);
          } else if (sym.endsWith("-USD")) {
            h2CryptoStats.push(stat);
          } else {
            h2UsaStats.push(stat);
          }
        }

        // Send H2 TASE message
        if (h2TaseStats.length > 0) {
          const tasMsg = buildGroupMessage("H2 TASE (TA)", "🇮🇱", h2TaseStats, dateStr);
          await sendTelegramMessage(tasMsg, chatId);
          console.log(`[AlertPoller] Daily summary H2 TASE sent (${h2TaseStats.length} positions)`);
          await sleep(500);
        }

        // Send H2 USA message
        if (h2UsaStats.length > 0) {
          const usaMsg = buildGroupMessage("H2 USA", "🇺🇸", h2UsaStats, dateStr);
          await sendTelegramMessage(usaMsg, chatId);
          console.log(`[AlertPoller] Daily summary H2 USA sent (${h2UsaStats.length} positions)`);
          await sleep(500);
        }

        // H2 Crypto — include in All Accounts but don't send a separate message unless there are positions
        if (h2CryptoStats.length > 0) {
          const cryptoMsg = buildGroupMessage("H2 Crypto", "₿", h2CryptoStats, dateStr);
          await sendTelegramMessage(cryptoMsg, chatId);
          console.log(`[AlertPoller] Daily summary H2 Crypto sent (${h2CryptoStats.length} positions)`);
          await sleep(500);
        }
      }
    } catch (err) {
      console.warn("[AlertPoller] Error building H2 daily summary:", err);
    }

    // ════════════════════════════════════════════════════════════════════════
    // MESSAGE 4: All Accounts (total with ILS)
    // ════════════════════════════════════════════════════════════════════════
    try {
      const allStats = [...h1Stats, ...h2TaseStats, ...h2UsaStats, ...h2CryptoStats];
      if (allStats.length > 0) {
        const allMsg = buildGroupMessage("כל החשבונות", "🌐", allStats, dateStr, ilsRate);
        await sendTelegramMessage(allMsg, chatId);
        console.log(`[AlertPoller] Daily summary All Accounts sent (${allStats.length} total positions, ILS rate: ${ilsRate.toFixed(3)})`);
      } else {
        await sendTelegramMessage("📭 <b>אין פוזיציות פתוחות כרגע.</b>", chatId);
      }
    } catch (err) {
      console.warn("[AlertPoller] Error building All Accounts daily summary:", err);
    }

    // ════════════════════════════════════════════════════════════════════════
    // MESSAGE 5: Gold Catalogue Opportunities (Gold Breakout + Gold Retest)
    // ════════════════════════════════════════════════════════════════════════
    try {
      const goldAssets = await db
        .select()
        .from(userAssets)
        .where(
          and(
            inArray(userAssets.tier, ["Gold Breakout", "Gold Retest"]),
            eq(userAssets.archived, 0)
          )
        )
        .orderBy(desc(userAssets.score));

      if (goldAssets.length > 0) {
        const goldParts: string[] = [
          `🏆 <b>trade-snow2.vip — הזדמנויות קנייה מהקטלוג</b>`,
          `<i>${dateStr}</i>`,
          ``,
          `<b>${goldAssets.length} מניות Gold Breakout / Gold Retest</b>`,
          ``,
          `<code>Ticker     Tier           Score  Entry     SL</code>`,
          `<code>─────────────────────────────────────────────</code>`,
        ];

        for (const a of goldAssets) {
          const ticker = (a.ticker ?? "").slice(0, 9).padEnd(9);
          const tier = (a.tier ?? "").replace("Gold ", "").slice(0, 13).padEnd(13);
          const score = a.score != null ? a.score.toFixed(1).padStart(5) : "  N/A";
          const entry = a.recommendedBuyPrice != null
            ? `$${a.recommendedBuyPrice.toFixed(2)}`.padStart(8)
            : "      N/A";
          const sl = a.recommendedStopLoss != null
            ? `$${a.recommendedStopLoss.toFixed(2)}`.padStart(8)
            : "      N/A";
          const emoji = (a.tier ?? "").includes("Breakout") ? "🚀" : "🔄";
          goldParts.push(`${emoji}<code>${ticker} ${tier} ${score} ${entry} ${sl}</code>`);
          // Add note/reason if available
          if (a.note) {
            goldParts.push(`   📝 ${a.note.slice(0, 120)}`);
          }
        }

        const goldMsg = goldParts.join("\n");
        await sendTelegramMessage(goldMsg, chatId);
        console.log(`[AlertPoller] Daily summary Gold catalogue sent (${goldAssets.length} assets)`);
      } else {
        console.log(`[AlertPoller] No Gold Breakout/Retest assets found — skipping catalogue message`);
      }
    } catch (err) {
      console.warn("[AlertPoller] Error building Gold catalogue daily summary:", err);
    }

    console.log(`[AlertPoller] Daily summary complete for owner (userId=${ownerUserId})`);
  } catch (err) {
    console.warn("[AlertPoller] Error during daily summary:", err);
  }
}

/**
 * Auto-save daily snapshots for H2 TASE/USA/Crypto at 19:00 Israel time
 * Uses live IBKR prices to compute total value per group and upserts into portfolioSnapshots.
 */
async function runH2AutoSnapshot() {
  try {
    const db = await getDb();
    if (!db) return;

    // Resolve owner userId
    let ownerUserId: number | null = null;
    if (ENV.ownerOpenId) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      ownerUserId = ownerUser?.id ?? null;
    }
    if (ownerUserId == null) ownerUserId = 1;

    const today = new Date().toISOString().slice(0, 10);

    // Fetch all H2 holdings
    const allH2 = await db.select().from(holding2).where(eq(holding2.userId, ownerUserId));
    const h2Holdings = allH2.filter((h: { units: number }) => h.units !== 0);
    if (h2Holdings.length === 0) {
      console.log("[AlertPoller] H2 auto-snapshot: no holdings, skipping");
      return;
    }

    const h2Tickers = h2Holdings.map((h: { ticker: string }) => h.ticker);
    const pricesMap = await fetchIbkrLivePricesBatch(h2Tickers);

    // Group totals — track how many tickers got fresh prices per group
    let taseTotalValue = 0, usaTotalValue = 0, cryptoTotalValue = 0;
    let taseFreshCount = 0, taseTotal = 0;
    let usaFreshCount = 0, usaTotal = 0;
    let cryptoFreshCount = 0, cryptoTotal = 0;
    for (const h of h2Holdings) {
      const sym = h.ticker.toUpperCase();
      const lp = pricesMap.get(h.ticker) ?? pricesMap.get(sym);
      const hasFreshPrice = !!lp;
      const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
      const mktValue = price * h.units;
      if (sym.endsWith(".TA")) {
        taseTotalValue += mktValue;
        taseTotal++;
        if (hasFreshPrice) taseFreshCount++;
      } else if (sym.endsWith("-USD")) {
        cryptoTotalValue += mktValue;
        cryptoTotal++;
        if (hasFreshPrice) cryptoFreshCount++;
      } else {
        usaTotalValue += mktValue;
        usaTotal++;
        if (hasFreshPrice) usaFreshCount++;
      }
    }

    // Upsert snapshot for each group (only if value > 0 AND enough fresh prices)
    // Skip snapshot if less than 50% of tickers got fresh prices (prevents stale data)
    const groups: Array<{ type: string; value: number; freshCount: number; total: number }> = [
      { type: "h2-tase", value: taseTotalValue, freshCount: taseFreshCount, total: taseTotal },
      { type: "h2-usa", value: usaTotalValue, freshCount: usaFreshCount, total: usaTotal },
      { type: "h2-crypto", value: cryptoTotalValue, freshCount: cryptoFreshCount, total: cryptoTotal },
    ];
    for (const g of groups) {
      if (g.value <= 0) continue;
      // Skip if less than 50% of tickers got fresh prices from IBKR
      const freshRatio = g.total > 0 ? g.freshCount / g.total : 0;
      if (freshRatio < 0.5) {
        console.log(`[AlertPoller] H2 auto-snapshot SKIPPED: ${g.type} — only ${g.freshCount}/${g.total} tickers got fresh prices (${(freshRatio * 100).toFixed(0)}%)`);
        continue;
      }
      await upsertPortfolioSnapshot({
        userId: ownerUserId,
        snapshotDate: today,
        portfolioType: g.type,
        totalValue: g.value,
        investedValue: g.value,
        cashBalance: 0,
        totalCost: g.value,
        pnlUsd: 0,
        pnlPct: 0,
        totalEquity: g.value,
        unrealizedPnL: null,
        h2Value: g.value,
      });
      console.log(`[AlertPoller] H2 auto-snapshot saved: ${g.type} = $${g.value.toFixed(0)} on ${today}`);
    }
  } catch (err) {
    console.warn("[AlertPoller] Error during H2 auto-snapshot:", err);
  }
}

/**
 * Auto-refresh H2 crypto prices every 5 minutes.
 * Crypto trades 24/7 so we always fetch fresh prices from CoinGecko fallback.
 */
async function refreshH2CryptoPrices() {
  try {
    const db = await getDb();
    if (!db) return;
    let ownerUserId: number | null = null;
    if (ENV.ownerOpenId) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      ownerUserId = ownerUser?.id ?? null;
    }
    if (ownerUserId == null) ownerUserId = 1;

    const allH2 = await db.select().from(holding2).where(eq(holding2.userId, ownerUserId));
    const cryptoHoldings = allH2.filter((h: { ticker: string; units: number }) =>
      h.units !== 0 && h.ticker.toUpperCase().endsWith("-USD")
    );
    if (cryptoHoldings.length === 0) return;

    const tickers = cryptoHoldings.map((h: { ticker: string }) => h.ticker);
    const priceMap = await fetchIbkrLivePricesBatch(tickers); // will use CoinGecko fallback for crypto

    let updated = 0;
    for (const h of cryptoHoldings) {
      const lp = priceMap.get(h.ticker) ?? priceMap.get(h.ticker.toUpperCase());
      if (!lp) continue;
      const prevClose = lp.prevClose ?? (lp.price - (lp.change ?? 0));
      await db
        .update(holding2)
        .set({
          currentPrice: lp.price,
          prevClose: prevClose > 0 ? prevClose : null,
          dailyChangePercent: lp.changePercent ?? null,
          priceUpdatedAt: new Date(),
        })
        .where(eq(holding2.id, h.id));
      updated++;
    }
    if (updated > 0) {
      console.log(`[CryptoRefresh] Updated ${updated} crypto prices (${tickers.join(", ")})`);
    }
  } catch (err) {
    console.warn("[CryptoRefresh] Error:", err);
  }
}

/**
 * Save daily baseline prices for all H1 + H2 holdings at 23:30 Israel time.
 * Uses Yahoo Finance `regularMarketPrice` (= official RTH close at 16:00 ET) as the baseline.
 * This ensures Today% matches IBKR App's CHG% exactly.
 * Dedup: only runs once per day (checked via dailyBaseTs within the last 10 minutes).
 *
 * IMPORTANT: Yahoo Finance is ONLY used here for the static end-of-day baseline.
 * Live market data during RTH continues to use iBind Gateway exclusively.
 */
async function runDailyBasePriceSnapshot() {
  try {
    const db = await getDb();
    if (!db) return;
    let ownerUserId: number | null = null;
    if (ENV.ownerOpenId) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      ownerUserId = ownerUser?.id ?? null;
    }
    if (ownerUserId == null) ownerUserId = 1;
    const now = Date.now();

    // ── H1 holdings ──────────────────────────────────────────────────────────
    const h1Holdings = await db
      .select({ id: portfolioHoldings.id, ticker: portfolioHoldings.ticker, currentPrice: portfolioHoldings.currentPrice, dailyBaseTs: portfolioHoldings.dailyBaseTs })
      .from(portfolioHoldings)
      .where(eq(portfolioHoldings.userId, ownerUserId));
    const h1ToUpdate = h1Holdings.filter(h => {
      if (!h.currentPrice || h.currentPrice <= 0) return false;
      // Skip if already snapshotted in the last 10 minutes
      if (h.dailyBaseTs && (now - h.dailyBaseTs) < 10 * 60 * 1000) return false;
      return true;
    });
    if (h1ToUpdate.length > 0) {
      const h1Tickers = h1ToUpdate.map(h => h.ticker);
      const rthCloses = await fetchYahooRthCloses(h1Tickers);
      for (const h of h1ToUpdate) {
        const rthClose = rthCloses.get(h.ticker) ?? rthCloses.get(h.ticker.toUpperCase());
        // Only update if we got a valid RTH close from Yahoo; otherwise keep existing
        if (rthClose && rthClose > 0) {
          await db.update(portfolioHoldings)
            .set({ dailyBasePrice: rthClose, dailyBaseTs: now })
            .where(eq(portfolioHoldings.id, h.id));
        }
      }
      const updated = h1ToUpdate.filter(h => (rthCloses.get(h.ticker) ?? rthCloses.get(h.ticker.toUpperCase())) != null).length;
      console.log(`[AlertPoller] 23:30 base snapshot (Yahoo RTH close): H1 updated ${updated}/${h1ToUpdate.length} tickers`);
    }

    // ── H2 holdings ──────────────────────────────────────────────────────────
    const h2Holdings = await db
      .select({ id: holding2.id, ticker: holding2.ticker, currentPrice: holding2.currentPrice, dailyBaseTs: holding2.dailyBaseTs })
      .from(holding2)
      .where(eq(holding2.userId, ownerUserId));
    const h2ToUpdate = h2Holdings.filter(h => {
      if (!h.currentPrice || h.currentPrice <= 0) return false;
      if (h.dailyBaseTs && (now - h.dailyBaseTs) < 10 * 60 * 1000) return false;
      return true;
    });
    if (h2ToUpdate.length > 0) {
      const h2Tickers = h2ToUpdate.map(h => h.ticker);
      const rthCloses = await fetchYahooRthCloses(h2Tickers);
      for (const h of h2ToUpdate) {
        const rthClose = rthCloses.get(h.ticker) ?? rthCloses.get(h.ticker.toUpperCase());
        if (rthClose && rthClose > 0) {
          await db.update(holding2)
            .set({ dailyBasePrice: rthClose, dailyBaseTs: now })
            .where(eq(holding2.id, h.id));
        }
      }
      const updated = h2ToUpdate.filter(h => (rthCloses.get(h.ticker) ?? rthCloses.get(h.ticker.toUpperCase())) != null).length;
      console.log(`[AlertPoller] 23:30 base snapshot (Yahoo RTH close): H2 updated ${updated}/${h2ToUpdate.length} tickers`);
    }
  } catch (err) {
    console.warn("[AlertPoller] Error during 23:30 base snapshot:", err);
  }
}

/**
 * Fetch the PRIOR-session RTH close from Yahoo Finance for a batch of tickers.
 * This is the baseline against which "today's change" is measured (current − priorClose).
 * Uses the second-to-last non-null daily bar close (chart.result[0].indicators.quote[0].close),
 * NOT meta.regularMarketPrice (which is the LATEST/today's close → would yield +0.00% for a
 * .TA ticker snapshotted at 23:30 IL after TASE close). Falls back to regularMarketPrice only
 * when fewer than 2 daily bars are available (no prior day — never fabricate).
 * Returns a Map<ticker, priorCloseInUSD>.
 *
 * For .TA tickers: Yahoo returns price in ILA (Agorot), converted to USD via ILS rate.
 * Rate limiting: 5 tickers per parallel batch, 300ms delay between batches.
 */
// ── RTH Close cache — prevents Yahoo timeout from stalling the 23:30 baseline task ──
const _rthCloseCache = new Map<string, { price: number; ts: number }>();
const RTH_CACHE_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours

async function fetchYahooRthCloses(tickers: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (tickers.length === 0) return map;

  // Get ILS rate for TASE tickers
  let ilsRate = 3.60;
  const hasTase = tickers.some(t => t.toUpperCase().endsWith('.TA'));
  if (hasTase) {
    try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
  }

  const CHUNK = 5;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(async (ticker) => {
      try {
        const yahooSymbol = normalizeTickerSymbol(ticker);
        // ⚠️ Strict 2s timeout — Yahoo must not freeze the Event Loop
        const res = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d&includePrePost=false`,
          {
            signal: AbortSignal.timeout(2000),
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Accept": "application/json",
            },
          }
        );
        if (!res.ok) {
          // On non-2xx: fallback to cache
          const cached = _rthCloseCache.get(ticker);
          if (cached && Date.now() - cached.ts < RTH_CACHE_TTL_MS) {
            console.log(`[RTHClose] Yahoo ${res.status} for ${ticker} — using cached price ${cached.price}`);
            return { ticker, price: cached.price };
          }
          return { ticker, price: null };
        }

        const text = await res.text();
        if (!text.trimStart().startsWith("{")) return { ticker, price: null };
        const data = JSON.parse(text);

        const result0 = data?.chart?.result?.[0];
        const meta = result0?.meta;
        if (!meta) return { ticker, price: null };

        // ── dailyBasePrice MUST be the PRIOR-session close (the baseline for "today's change"). ──
        // Yahoo's meta.regularMarketPrice is the LATEST session close — for a .TA ticker fetched
        // at 23:30 IL (after TASE close ~17:25 IL) that is TODAY's close, so current−base = 0.
        // Instead take the second-to-last non-null daily close from the chart bars = yesterday's
        // RTH close. This is the correct start-of-day baseline for ALL tickers (US + .TA alike):
        // the displayed "today's change" is always (current − prior-session close).
        const closes: Array<number | null> | undefined =
          result0?.indicators?.quote?.[0]?.close;
        const nonNullCloses = Array.isArray(closes)
          ? closes.filter((c): c is number => typeof c === "number" && c > 0)
          : [];
        // Need at least 2 sessions to know the PRIOR close. With only 1 (or 0) bar there is no
        // prior day → fall back to meta.regularMarketPrice (preserve old behavior, never fabricate).
        const priorClose: number | null =
          nonNullCloses.length >= 2 ? nonNullCloses[nonNullCloses.length - 2] : null;

        if (priorClose == null && !meta.regularMarketPrice) return { ticker, price: null };

        const rawPrice: number = priorClose ?? meta.regularMarketPrice;
        const currency: string = meta.currency ?? "USD";

        // Convert to USD: ILA (agorot) → ÷100÷rate; ILS (shekel) → ÷rate; USD → passthrough
        const fxRate = ilsRate > 0 ? ilsRate : 3.6;
        let priceUsd: number;
        if (currency === "ILA") {
          priceUsd = rawPrice / 100 / fxRate;
        } else if (currency === "ILS") {
          priceUsd = rawPrice / fxRate;
        } else {
          priceUsd = rawPrice;
        }

        // Update cache on success
        _rthCloseCache.set(ticker, { price: priceUsd, ts: Date.now() });
        return { ticker, price: priceUsd };
      } catch (err: any) {
        // Timeout or network error — use cache rather than blocking
        const cached = _rthCloseCache.get(ticker);
        if (cached && Date.now() - cached.ts < RTH_CACHE_TTL_MS) {
          console.log(`[RTHClose] Yahoo timeout/error for ${ticker} (${err?.name ?? "err"}) — using cached price ${cached.price}`);
          return { ticker, price: cached.price };
        }
        return { ticker, price: null };
      }
    }));

    for (const { ticker, price } of results) {
      if (price != null && price > 0) {
        map.set(ticker, price);
      }
    }

    // Rate limit: 300ms between chunks
    if (i + CHUNK < tickers.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return map;
}

let basePriceSnapshotDoneToday = '';
/**
 * Check if it's time to save the 23:30 daily baseline prices (23:30-23:35 Israel)
 */
function checkDailyBasePriceTime() {
  const now = new Date();
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMinute = now.getUTCMinutes();
  const todayKey = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (israelHour === 23 && israelMinute >= 30 && israelMinute < 35 && basePriceSnapshotDoneToday !== todayKey) {
    basePriceSnapshotDoneToday = todayKey;
    runDailyBasePriceSnapshot();
  }
}

// ── A5: Daily trading journal → Telegram at 23:10 Israel time (after market close 23:00) ──
let _journalSentToday = '';
function checkDailyJournalTime() {
  const now = new Date();
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMinute = now.getUTCMinutes();
  const todayKey = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (israelHour === 23 && israelMinute >= 10 && israelMinute < 15 && _journalSentToday !== todayKey) {
    _journalSentToday = todayKey;
    import("./tradingJournal")
      .then(({ sendDailyTradingJournal }) => sendDailyTradingJournal(1))
      .catch((e) => console.warn("[Journal] error:", e?.message ?? e));
  }
}

// ── Dynamic VIP daily refresh — recompute VIP-A/B/BENCH tiers at 17:00 IL (before pre-RTH) ──
let _vipRefreshDoneToday = '';
function checkDailyVipRefreshTime() {
  const now = new Date();
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMinute = now.getUTCMinutes();
  const todayKey = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (israelHour === 17 && israelMinute < 5 && _vipRefreshDoneToday !== todayKey) {
    _vipRefreshDoneToday = todayKey;
    import("./dynamicVipRefresh")
      .then(({ computeVipSnapshot }) => computeVipSnapshot(Date.now(), { persist: true }))
      .then((s) => console.log(`[DynamicVIP] daily refresh: VIP-A ${s.tiers["VIP-A"].length} / VIP-B ${s.tiers["VIP-B"].length} / BENCH ${s.tiers.BENCH.length}`))
      .catch((e) => console.warn("[DynamicVIP] refresh error:", e?.message ?? e));
  }
}

/**
 * Check if it's time to send the daily summary (09:00 Israel time = 06:00 UTC)
 */
function checkDailySummaryTime() {
  const now = new Date();
  // Israel time = UTC+3 (standard) / UTC+2 (winter) — use UTC+3 for simplicity
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMinute = now.getUTCMinutes();

  // DISABLED: 09:00 daily summary to Telegram (user request 2026-05-21)
  // if (israelHour === 9 && israelMinute < 5) {
  //   runDailySummary();
  // }
}

/**
 * Check if it's time to save H2 auto-snapshots (19:00 Israel time = 16:00 UTC)
 */
function checkH2SnapshotTime() {
  const now = new Date();
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMinute = now.getUTCMinutes();
  // Save at 19:00-19:05 Israel time
  if (israelHour === 19 && israelMinute < 5) {
    runH2AutoSnapshot();
  }
}

// ── Hourly NLV Snapshot ────────────────────────────────────────────────────
let _lastHourlySnapshotHour = -1;
async function maybeRunHourlySnapshot(): Promise<void> {
  const now = new Date();
  const israelHour = (now.getUTCHours() + 3) % 24;
  if (israelHour === _lastHourlySnapshotHour) return; // already ran this hour
  _lastHourlySnapshotHour = israelHour;
  try {
    const { getDb, getUserByOpenId } = await import("./db");
    const { portfolioAccounts, holding2, hourlySnapshots } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { fetchLivePricesBatch } = await import("./marketData");
    const db = await getDb();
    if (!db) return;
    let userId = 1;
    if (ENV.ownerOpenId) {
      const owner = await getUserByOpenId(ENV.ownerOpenId);
      if (owner?.id) userId = owner.id;
    }
    // H1: NLV from portfolioAccounts
    const [account] = await db.select().from(portfolioAccounts).where(eq(portfolioAccounts.userId, userId)).limit(1);
    const h1Value: number | null = account?.lastKnownNetLiquidation ?? account?.lastKnownNLV ?? null;
    // H2: compute from holding2
    const h2Holdings = await db.select().from(holding2).where(eq(holding2.userId, userId));
    let h2Value = 0;
    if (h2Holdings.length > 0) {
      const tickers = Array.from(new Set(h2Holdings.map((h: any) => h.ticker)));
      const livePricesMap = await fetchLivePricesBatch(tickers);
      for (const h of h2Holdings) {
        const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
        const price = lp?.price ?? h.currentPrice ?? h.buyPrice ?? 0;
        h2Value += price * (h.units ?? 0);
      }
    }
    const combinedValue = (h1Value ?? 0) + h2Value;
    const hourTs = Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60 * 1000);
    await db.insert(hourlySnapshots).values({
      userId, snapshotTs: hourTs, h1Value, h2Value, combinedValue,
    }).onDuplicateKeyUpdate({ set: { h1Value, h2Value, combinedValue } });
    console.log(`[HourlySnapshot] Saved: H1=${h1Value?.toFixed(0) ?? 'N/A'} H2=${h2Value.toFixed(0)} Combined=${combinedValue.toFixed(0)}`);
  } catch (err) {
    console.warn("[HourlySnapshot] Error (non-fatal):", err);
  }
}

// ── Hourly Analyze All Cron ──────────────────────────────────────────────────
// Runs every 20 minutes during US market hours (17:00-23:00 Israel time)
// Re-scores all catalogue assets so Paper Lab has fresh hotSignal + momentumSignal data.
let lastAnalyzeSlot = -1; // tracks which 20-min slot last ran (unique key per slot)
let hourlyAnalyzeRunning = false;
// ── Intraday Armed-Watcher reentrancy latch (BUILD-spec F4b) ──────────────────
// Prevents a 75s watcher tick from stacking on a slow predecessor. The watcher tick
// also skips while hourlyAnalyzeRunning (universe/war scan) is true so a 75s tick
// never overlaps the 2-min scan. INERT when the flag is 0 (the tick early-returns).
let _watcherRunning = false;

/**
 * Headless version of Analyze All — same logic as analyzeStream.ts but without SSE.
 * Iterates all catalogue assets, runs Ziv Engine, persists scores + hotSignal to DB.
 */
async function runHourlyAnalyzeAll(): Promise<void> {
  if (hourlyAnalyzeRunning) {
    console.log("[HourlyAnalyze] Already running — skipping");
    return;
  }
  hourlyAnalyzeRunning = true;
  const startTime = Date.now();
  try {
    // Get owner userId
    let ownerUserId: number | null = null;
    if (ENV.ownerOpenId) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      ownerUserId = ownerUser?.id ?? null;
    }
    if (ownerUserId == null) ownerUserId = 1;

    const assets = await getUserAssets(ownerUserId);
    // Exclude .TA tickers — they are handled by the separate TASE scan (10:00-17:00 Israel)
    const tickers = (assets ?? []).map((a: any) => a.ticker).filter((t: string) => t && t.length > 0 && !t.toUpperCase().endsWith(".TA"));
    if (tickers.length === 0) {
      console.log("[HourlyAnalyze] No catalogue assets — skipping");
      return;
    }

    // No ILS rate needed — .TA tickers are handled by separate TASE scan

    let scored = 0;
    let skipped = 0;
    let hotCount = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i].toUpperCase();
      try {
        const rawBars = await fetchBarsForTicker(ticker, 420);
        if (rawBars.length < 50) { skipped++; continue; }

        const bars = rawBars; // .TA tickers excluded from US scan

        const ziv = calcZivEngineScore(bars);
        const score = ziv.score;
        const recommendation = ziv.tier === "Gold Breakout" ? "STRONG BUY"
          : ziv.tier === "Gold Retest" ? "BUY"
          : ziv.tier === "Near Entry Watch" ? "WATCH" : "AVOID";

        let recommendedBuyPrice: number;
        if (ziv.tier === "Gold Breakout") {
          recommendedBuyPrice = parseFloat(ziv.price.toFixed(2));
        } else if (ziv.tier === "Gold Retest") {
          recommendedBuyPrice = parseFloat(ziv.ema50.toFixed(2));
        } else {
          recommendedBuyPrice = parseFloat((ziv.ema50 * 0.99).toFixed(2));
        }

        const last14 = bars.slice(-14);
        const atr14 = last14.reduce((sum, bar, idx) => {
          const prevClose = idx > 0 ? last14[idx - 1].close : bar.close;
          const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
          return sum + tr;
        }, 0) / 14;
        const atrStopLoss = parseFloat((recommendedBuyPrice - atr14 * 1.5).toFixed(2));
        const emaStopLoss = parseFloat((ziv.ema50 * 0.97).toFixed(2));
        const rawStop = Math.min(atrStopLoss, emaStopLoss);
        const minStop = parseFloat((recommendedBuyPrice * 0.995).toFixed(2));
        const recommendedStopLoss = Math.min(rawStop, minStop);

        const hotSignal = (
          (ziv.tier === "Gold Breakout" || ziv.tier === "Gold Retest") &&
          ziv.price > ziv.ema200 &&
          ziv.weeklyEma50Slope > 0
        ) ? 1 : 0;

        // Fetch live price (best-effort, 5s timeout)
        let liveChangePercent: number | null = null;
        try {
          const live = await Promise.race([
            fetchLivePrice(ticker),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          liveChangePercent = (live as any)?.changePercent ?? null;
        } catch { /* ignore */ }

        // Update for ALL users who have this ticker (not just owner)
        const scanPayload = {
          cmp: ziv.price,
          ema50: ziv.ema50,
          ema200: ziv.ema200,
          proximityToEma50Pct: ziv.distToEma50Pct,
          recommendation,
          reason: ziv.reason,
          tier: ziv.tier,
          weeklyEma50Slope: ziv.weeklyEma50Slope,
          donchian20High: ziv.donchian20High,
          priceAction: ziv.priceAction ?? undefined,
          recommendedBuyPrice,
          recommendedStopLoss,
          hotSignal,
        };
        // Find all users who have this ticker
        const db = await getDb();
        if (db) {
          const usersWithTicker = await db.select({ userId: userAssets.userId })
            .from(userAssets)
            .where(eq(userAssets.ticker, ticker));
          const userIds = new Set(usersWithTicker.map(r => r.userId));
          // Always include owner
          userIds.add(ownerUserId!);
          for (const uid of Array.from(userIds)) {
            await updateUserAssetScore(uid, ticker, score, liveChangePercent, scanPayload);
          }
        } else {
          await updateUserAssetScore(ownerUserId!, ticker, score, liveChangePercent, scanPayload);
        }

        scored++;
        if (hotSignal) hotCount++;

        // ── Unified BUY Signal: send Telegram when hotSignal=1 + Ziv>=8 + price near entry ──
        if (hotSignal && score >= ZIV_SCORE_THRESHOLD && BOT_TOKEN) {
          // Entry proximity guard: only send if price is within 5% above recommendedBuyPrice
          const entryProximityOk = ziv.price <= recommendedBuyPrice * 1.05;
          if (entryProximityOk) {
            // Anti-spam: 24h cooldown per ticker (DB-backed, survives deploy)
            const dbSpam = await getDb();
            const spamRow = dbSpam ? await dbSpam.select({ lastSignalSentAt: userAssets.lastSignalSentAt })
              .from(userAssets).where(and(eq(userAssets.ticker, ticker), eq(userAssets.userId, ownerUserId!))).limit(1) : [];
            const lastSentTime = spamRow[0]?.lastSignalSentAt?.getTime() ?? 0;
            if (Date.now() - lastSentTime >= ANTI_SPAM_MS) {
              // Persist cooldown to DB
              if (dbSpam) {
                await dbSpam.update(userAssets).set({ lastSignalSentAt: new Date() })
                  .where(and(eq(userAssets.ticker, ticker), eq(userAssets.userId, ownerUserId!)));
              }
              // Compute TP from entry + 2.5*(entry - SL)
              const sigTp = (recommendedBuyPrice > recommendedStopLoss)
                ? recommendedBuyPrice + 2.5 * (recommendedBuyPrice - recommendedStopLoss)
                : null;
              // Sanity: hide SL if >= price, hide TP if <= price
              const validSigSl = (recommendedStopLoss < ziv.price) ? recommendedStopLoss : null;
              const validSigTp = (sigTp != null && sigTp > ziv.price) ? sigTp : null;
              const changePctStr = liveChangePercent != null
                ? ` (${liveChangePercent >= 0 ? "+" : ""}${liveChangePercent.toFixed(2)}% today)`
                : "";
              const msg = formatAlertMessage({
                ticker,
                alertType: "custom",
                targetPrice: recommendedBuyPrice,
                currentPrice: ziv.price,
                changePercent: liveChangePercent,
                zivScore: score,
                catalogSl: validSigSl,
                catalogTp: validSigTp,
              });
              // Send to all Telegram-enabled users
              const db2 = await getDb();
              if (db2) {
                const tgUsers = await db2.select({ userId: userSettings.userId, telegramChatId: userSettings.telegramChatId })
                  .from(userSettings)
                  .where(and(eq(userSettings.telegramEnabled, 1), isNotNull(userSettings.telegramChatId)));
                for (const tgUser of tgUsers) {
                  if (tgUser.telegramChatId) {
                    await sendTelegramMessage(msg, tgUser.telegramChatId);
                  }
                }
                // Also send to owner if not in settings
                const ownerInSettings = tgUsers.some(u => u.telegramChatId === OWNER_CHAT_ID);
                if (!ownerInSettings && OWNER_CHAT_ID) {
                  await sendTelegramMessage(msg, OWNER_CHAT_ID);
                }
              } else if (OWNER_CHAT_ID) {
                await sendTelegramMessage(msg, OWNER_CHAT_ID);
              }
              console.log(`[HourlyAnalyze] 🔔 BUY SIGNAL sent: ${ticker} @ $${ziv.price.toFixed(2)} | Ziv=${score.toFixed(1)} | Entry=$${recommendedBuyPrice.toFixed(2)}`);
            }
          }
        }
      } catch (err: any) {
        skipped++;
      }

      // Rate limiting: every 3 tickers, pause 500ms
      if (i > 0 && i % 3 === 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    }


    // ── SHORT SIGNAL SCAN ─────────────────────────────────────────────────────
    // After the LONG scan completes, run Bear scoring on the same USA tickers.
    // Sends a SHORT alert to Telegram when:
    //   score >= 7 (Bear Retest or Bear Breakdown) + 6h anti-spam per ticker
    let shortSignals = 0;
    const BEAR_SCORE_THRESHOLD = 7; // min score to send SHORT alert (Retest or Breakdown)

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i].toUpperCase();
      try {
        const barsRaw = await fetchBarsForTicker(ticker, 250);
        if (barsRaw.length < 50) continue;

        const bear = calcBearScore(barsRaw);
        if (bear.score < BEAR_SCORE_THRESHOLD) continue; // skip weak/no signal

        // Anti-spam: 6h cooldown per ticker for SHORT signals (DB-backed)
        const dbS = await getDb();
        if (!dbS) continue;
        const spamRow = await dbS.select({ lastSignalSentAt: userAssets.lastSignalSentAt })
          .from(userAssets)
          .where(and(eq(userAssets.ticker, ticker), eq(userAssets.userId, ownerUserId!)))
          .limit(1);
        const lastShortSent = spamRow[0]?.lastSignalSentAt?.getTime() ?? 0;
        if (Date.now() - lastShortSent < ANTI_SPAM_MS) {
          // Still in cooldown — skip
          continue;
        }

        // Fetch live price + change%
        let livePrice = bear.price;
        let liveChangePct: number | null = null;
        try {
          const live = await Promise.race([
            fetchLivePrice(ticker),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          if (live) {
            livePrice = (live as any).price ?? bear.price;
            liveChangePct = (live as any).changePercent ?? null;
          }
        } catch { /* use bar close */ }

        // Compute SL / TP
        const sl = calcShortSL(barsRaw, livePrice);
        const riskPerShare = sl - livePrice;
        const tp = Math.max(0, livePrice - 3 * riskPerShare); // R:R = 1:3

        // Build SHORT Telegram message
        const shortMsg = formatAlertMessage({
          ticker,
          alertType: "short",
          targetPrice: livePrice,
          currentPrice: livePrice,
          changePercent: liveChangePct,
          zivScore: bear.score,
          catalogSl: parseFloat(sl.toFixed(2)),
          catalogTp: parseFloat(tp.toFixed(2)),
          broadcastPrefix: `🐻 <b>Bear ${bear.tier}</b>\n📋 ${bear.reason.slice(0, 120)}`,
        });

        // Update anti-spam timestamp in DB
        await dbS.update(userAssets)
          .set({ lastSignalSentAt: new Date() })
          .where(and(eq(userAssets.ticker, ticker), eq(userAssets.userId, ownerUserId!)));

        // ── SHORT Telegram alerts DISABLED (user preference — too noisy) ──
        // Short signals are still scored and stored in DB, just not sent to Telegram.
        shortSignals++;
        console.log(`[HourlyAnalyze] 🐻 SHORT SIGNAL (no-send): ${ticker} @ $${livePrice.toFixed(2)} | Bear score=${bear.score.toFixed(1)} | SL=$${sl.toFixed(2)} | TP=$${tp.toFixed(2)}`);
      } catch (err: any) {
        // non-fatal — skip ticker
      }

      // Rate limit: pause every 3 tickers
      if (i > 0 && i % 3 === 0) await new Promise(r => setTimeout(r, 300));
    }
    // ── END SHORT SCAN ──────────────────────────────────────────────────────────

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[HourlyAnalyze] ✅ Done in ${elapsed}s — scored ${scored}, skipped ${skipped}, hot signals: ${hotCount}`);

    // ── LEGACY Kronos catalogue-bias refresh — DISABLED (superseded by
    //    kronosConvictionJob 2026-06-25; legacy .cursor/skills/kronos path is broken
    //    on the live droplet → spawned a failing python subprocess that threw noisy
    //    tracebacks into error.log). The NEW entry-conviction path
    //    (kronosConvictionJob.ts, scheduled at :05) fully supersedes this catalogue
    //    bias. userAssets.kronosBias is now intentionally stale/absent: the ONLY
    //    consumer is the catalogue display in portfolio.ts, which tolerates a null
    //    bias (computeCompositeScore(ziv, null) === ziv). No scan/gate/entry path
    //    depends on a fresh kronosBias, so disabling this refresh is functionally
    //    inert. kronosEngine.ts is kept (types/exports still imported elsewhere).
    const LEGACY_KRONOS_CATALOGUE_REFRESH_ENABLED = false;
    if (LEGACY_KRONOS_CATALOGUE_REFRESH_ENABLED) {
      try {
        const kronosUpdated = await refreshKronosCatalogueBatch(ownerUserId!);
        if (kronosUpdated > 0) {
          console.log(`[HourlyAnalyze] 🔮 Kronos updated ${kronosUpdated} catalogue ticker(s)`);
        }
      } catch (kronosErr: any) {
        console.warn(`[HourlyAnalyze] Kronos refresh error (non-fatal): ${kronosErr.message}`);
      }
    }
  } catch (err: any) {
    console.error("[HourlyAnalyze] Error:", err.message);
  } finally {
    hourlyAnalyzeRunning = false;
  }
}

/**
 * checkPeriodicAnalyzeTime — called every 5 minutes.
 * If we're in US market hours (16:30–23:00 Israel) and at a 20-min mark (XX:00, XX:20, XX:40),
 * triggers runHourlyAnalyzeAll.
 * In practice: runs 3 times per hour during market hours (21 scans total per day).
 */
async function checkPeriodicAnalyzeTime() {
  const now = new Date();
  // ── Weekend guard: US market is closed Sat+Sun (UTC day 0=Sun, 6=Sat) ─────────
  const utcDay = now.getUTCDay();
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMinute = now.getUTCMinutes();
  // Israel Saturday starts Fri ~21:00 UTC, Israel Sunday ends Sat ~21:00 UTC
  // Simple rule: if it's Saturday or Sunday UTC — US market is closed — skip entirely
  if (utcDay === 0 || utcDay === 6) {
    // Sunday UTC = still Sat night IL, Monday UTC = Sun in Israel — US closed
    console.log(`[PeriodicAnalyze] Weekend (UTC day=${utcDay}) — skipping all cycles 💤`);
    return;
  }
  // Run every 5 minutes during US market hours: 16:30-23:00 Israel time
  const afterOpen = israelHour > 16 || (israelHour === 16 && israelMinute >= 30);
  if (!(israelHour >= 16 && israelHour <= 23 && afterOpen)) return;

  // ── V2.00: Corporate Action Pre-Market Sync (runs once/day 14:30–16:20 IST) ──
  if (israelHour >= 14 && israelHour < 16 && !(israelHour === 16 && israelMinute >= 20)) {
    runCorporateActionSync(1).catch(e => console.warn("[CorpAction] Error:", e));
  }

  // ── Kronos Conviction Job — hourly at :05, DELIBERATELY off the :00/:20/:40 war
  // slots so the 4–12min CPU job never collides with the entry scan. Fire-and-forget,
  // never awaited by the war cycle. weight=0 inside the job is an early return (OFF).
  // The job only WRITES the cache; the war engine only READS it (never spawns kronos).
  if (israelMinute === 5 && israelHour >= 16 && israelHour <= 23) {
    import("./kronosConvictionJob").then(({ runKronosConvictionJob }) =>
      runKronosConvictionJob(1).catch(e => console.warn("[KronosConviction]", e))
    ).catch(e => console.warn("[KronosConviction] import", e));
  }

  // ── TIERED-CADENCE SLOT GUARD (BUILD-spec F4a) ───────────────────────────────
  // Default (today): full analyze+war cycle at :00, :20, :40 (3×/hr). The 5-min poll
  // only executes on the 20-min boundary slots — a 162-ticker scan takes >2min and must
  // not overlap. When the intraday-watcher flag is ON, the UNIVERSE cycle moves to :00
  // ONLY (1×/hr) — the armed-watcher's 60–90s confirm-cross handles intra-hour entry
  // timing instead, ~3× LESS /positions+/orders+bars load. flag=0 ⇒ is20MinSlot keeps
  // the EXACT :00/:20/:40 rule below → cadence byte-identical to today.
  let _watcherCadenceOn = false;
  try {
    const { getLiveConfig, isIntradayWatcherEnabled } = await import("./liveOrderExecutor");
    _watcherCadenceOn = isIntradayWatcherEnabled((await getLiveConfig(1)) as any);
  } catch { _watcherCadenceOn = false; }   // config read failed ⇒ today's cadence (fail-safe)

  const is20MinSlot = israelMinute === 0 || israelMinute === 20 || israelMinute === 40;
  // flag=0 → full cycle on every 20-min slot (today). flag=1 → full cycle at :00 only.
  const isFullCycleSlot = _watcherCadenceOn ? (israelMinute === 0) : is20MinSlot;
  if (!isFullCycleSlot) {
    // Between full-cycle slots: ONLY lightweight monitors (no entry scanning, no bars fetch).
    import("./liveOrderExecutor").then(({ runLiveSlMonitor }) => {
      runLiveSlMonitor(1).catch(e => console.warn("[SlMonitor] Error:", e));
    }).catch(() => {});
    // V2.00: Partial fill + halt recovery (lightweight, every 5min)
    runPartialFillMonitor(1).catch(e => console.warn("[PartialFill] Error:", e));
    runHaltRecoveryMonitor(1).catch(e => console.warn("[HaltRecovery] Error:", e));
    return;
  }

  console.log(`[PeriodicAnalyze] 🕐 War Engine ${_watcherCadenceOn ? "hourly" : "20-min"} cycle at ${israelHour}:${String(israelMinute).padStart(2,"0")} IST`);
  runHourlyAnalyzeAll().catch(e => console.error("[PeriodicAnalyze] Error:", e));
  // V2.00: Also run monitors on full-cycle ticks
  runPartialFillMonitor(1).catch(e => console.warn("[PartialFill] Error:", e));
  runHaltRecoveryMonitor(1).catch(e => console.warn("[HaltRecovery] Error:", e));

  // ── EOD Deleverage: handled by independent deleverageCron.ts (22:45 IST) ──

  // ── War Engine — autonomous LONG+SHORT decision layer (CEO ONLY — Dror gated off) ──
  // INVARIANT: periodic live trading MUST NOT change when Dror account exists.
  // Dror runs only after liveEngineConfig.isEnabled=1 AND MULTI_ACCOUNT_LIVE_ENABLED=1.
  import("./warEngine").then(async ({ runWarEngineCycle }) => {
    const _ownerUid = 1;
    const { getTradingAccountBySlug } = await import("./tradingAccounts");
    const ceoAcct = await getTradingAccountBySlug("ceo");
    runWarEngineCycle(_ownerUid, {
      tradingAccountId: ceoAcct?.id,
      onProgress: (p) => setProgress(p),
    }).then((r) => {
      if (r.entered > 0) {
        console.log(`[WarEngine] ✅ entered=${r.entered} managed=${r.managed} scanned=${r.scanned} regime=${r.regimeDecision}`);
      }
      if (r.liveSignals && r.liveSignals.length > 0) {
        import("./liveOrderExecutor").then(({ tryLiveEntry }) => {
          for (const sig of r.liveSignals) {
            tryLiveEntry({ userId: _ownerUid, ...sig })
              .then(res => console.log(`[LiveEngine] ${sig.ticker} → ${res.entered ? "✅ ENTERED" : "⏭ " + res.reason}`))
              .catch(e => console.error(`[LiveEngine] Entry error:`, e));
          }
        }).catch(e => console.error("[LiveEngine] Import error:", e));
      }
    }).catch(e => console.error("[WarEngine] Cycle error:", e));
  }).catch(e => console.error("[WarEngine] Import error:", e));
}

// ── TASE Scan: separate scan for Israeli stocks during TASE hours (10:00-17:00 Israel) ──
let lastTaseAnalyzeSlot = -1;
let taseAnalyzeRunning = false;

/**
 * runTaseAnalyze — scans only .TA tickers from the catalogue.
 * Sends BUY signals to Telegram when hotSignal=1 + Ziv>=8 + price near entry.
 * Does NOT interact with Paper Lab.
 */
async function runTaseAnalyze(): Promise<void> {
  if (taseAnalyzeRunning) {
    console.log("[TaseAnalyze] Already running — skipping");
    return;
  }
  taseAnalyzeRunning = true;
  const startTime = Date.now();
  try {
    let ownerUserId: number | null = null;
    if (ENV.ownerOpenId) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      ownerUserId = ownerUser?.id ?? null;
    }
    if (ownerUserId == null) ownerUserId = 1;

    const assets = await getUserAssets(ownerUserId);
    const tickers = (assets ?? [])
      .map((a: any) => a.ticker)
      .filter((t: string) => t && t.length > 0 && t.toUpperCase().endsWith(".TA"));
    if (tickers.length === 0) {
      console.log("[TaseAnalyze] No .TA assets in catalogue — skipping");
      return;
    }

    let ilsRate = 3.60;
    try { ilsRate = await getUsdIlsRate(); } catch { /* fallback */ }

    let scored = 0;
    let skipped = 0;
    let hotCount = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i].toUpperCase();
      try {
        const rawBars = await fetchBarsForTicker(ticker, 420);
        if (rawBars.length < 50) { skipped++; continue; }

        const bars = normalizeBarsForTicker(rawBars, ticker, ilsRate);

        const ziv = calcZivEngineScore(bars);
        const score = ziv.score;
        const recommendation = ziv.tier === "Gold Breakout" ? "STRONG BUY"
          : ziv.tier === "Gold Retest" ? "BUY"
          : ziv.tier === "Near Entry Watch" ? "WATCH" : "AVOID";

        let recommendedBuyPrice: number;
        if (ziv.tier === "Gold Breakout") {
          recommendedBuyPrice = parseFloat(ziv.price.toFixed(2));
        } else if (ziv.tier === "Gold Retest") {
          recommendedBuyPrice = parseFloat(ziv.ema50.toFixed(2));
        } else {
          recommendedBuyPrice = parseFloat((ziv.ema50 * 0.99).toFixed(2));
        }

        const last14 = bars.slice(-14);
        const atr14 = last14.reduce((sum, bar, idx) => {
          const prevClose = idx > 0 ? last14[idx - 1].close : bar.close;
          const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
          return sum + tr;
        }, 0) / 14;
        const atrStopLoss = parseFloat((recommendedBuyPrice - atr14 * 1.5).toFixed(2));
        const emaStopLoss = parseFloat((ziv.ema50 * 0.97).toFixed(2));
        const rawStop = Math.min(atrStopLoss, emaStopLoss);
        const minStop = parseFloat((recommendedBuyPrice * 0.995).toFixed(2));
        const recommendedStopLoss = Math.min(rawStop, minStop);

        const hotSignal = (
          (ziv.tier === "Gold Breakout" || ziv.tier === "Gold Retest") &&
          ziv.price > ziv.ema200 &&
          ziv.weeklyEma50Slope > 0
        ) ? 1 : 0;

        // Fetch live price (best-effort)
        let liveChangePercent: number | null = null;
        try {
          const live = await Promise.race([
            fetchLivePrice(ticker),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          liveChangePercent = (live as any)?.changePercent ?? null;
        } catch { /* ignore */ }

        // Update DB for all users with this ticker
        const scanPayload = {
          cmp: ziv.price,
          ema50: ziv.ema50,
          ema200: ziv.ema200,
          proximityToEma50Pct: ziv.distToEma50Pct,
          recommendation,
          reason: ziv.reason,
          tier: ziv.tier,
          weeklyEma50Slope: ziv.weeklyEma50Slope,
          donchian20High: ziv.donchian20High,
          priceAction: ziv.priceAction ?? undefined,
          recommendedBuyPrice,
          recommendedStopLoss,
          hotSignal,
        };
        const db = await getDb();
        if (db) {
          const usersWithTicker = await db.select({ userId: userAssets.userId })
            .from(userAssets)
            .where(eq(userAssets.ticker, ticker));
          const userIds = new Set(usersWithTicker.map(r => r.userId));
          userIds.add(ownerUserId!);
          for (const uid of Array.from(userIds)) {
            await updateUserAssetScore(uid, ticker, score, liveChangePercent, scanPayload);
          }
        } else {
          await updateUserAssetScore(ownerUserId!, ticker, score, liveChangePercent, scanPayload);
        }

        scored++;
        if (hotSignal) hotCount++;

        // ── Unified BUY Signal for TASE: send Telegram when hotSignal=1 + Ziv>=8 + price near entry ──
        if (hotSignal && score >= ZIV_SCORE_THRESHOLD && BOT_TOKEN) {
          const entryProximityOk = ziv.price <= recommendedBuyPrice * 1.05;
          if (entryProximityOk) {
            // ── USA market hours guard: 16:30–23:00 Israel time, Sun–Thu ──
            const nowIL = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
            const ilHour = nowIL.getHours() + nowIL.getMinutes() / 60;
            const ilDay = nowIL.getDay(); // 0=Sun, 6=Sat
            const inUsaHours = ilHour >= 16.5 && ilHour < 23.0 && ilDay >= 1 && ilDay <= 5;
            if (!inUsaHours) {
              console.log(`[HourlyAnalyze] ⏰ USA hours guard — skipping ${ticker} (IL hour=${ilHour.toFixed(1)}, day=${ilDay})`);
            } else {
            // ── Daily cap: max 5 USA LONG signals per day ──
            const todayIL = nowIL.toISOString().slice(0, 10);
            if (!_longSignalDayKey || _longSignalDayKey !== todayIL) {
              _longSignalDayKey = todayIL;
              _longSignalCount = 0;
            }
            const sentToday: number = _longSignalCount;
            if (sentToday >= 5) {
              console.log(`[HourlyAnalyze] 📵 Daily USA LONG cap reached (${sentToday}/5) — skipping ${ticker}`);
            } else {
            // Anti-spam: 24h cooldown per ticker (DB-backed, survives deploy)
            const dbSpamT = await getDb();
            const spamRowT = dbSpamT ? await dbSpamT.select({ lastSignalSentAt: userAssets.lastSignalSentAt })
              .from(userAssets).where(and(eq(userAssets.ticker, ticker), eq(userAssets.userId, ownerUserId!))).limit(1) : [];
            const lastSentTime = spamRowT[0]?.lastSignalSentAt?.getTime() ?? 0;
            if (Date.now() - lastSentTime >= ANTI_SPAM_MS) {
              if (dbSpamT) {
                await dbSpamT.update(userAssets).set({ lastSignalSentAt: new Date() })
                  .where(and(eq(userAssets.ticker, ticker), eq(userAssets.userId, ownerUserId!)));
              }
              const sigTp = (recommendedBuyPrice > recommendedStopLoss)
                ? recommendedBuyPrice + 2.5 * (recommendedBuyPrice - recommendedStopLoss)
                : null;
              const validSigSl = (recommendedStopLoss < ziv.price) ? recommendedStopLoss : null;
              const validSigTp = (sigTp != null && sigTp > ziv.price) ? sigTp : null;
              const msg = formatAlertMessage({
                ticker,
                alertType: "custom",
                targetPrice: recommendedBuyPrice,
                currentPrice: ziv.price,
                changePercent: liveChangePercent,
                zivScore: score,
                catalogSl: validSigSl,
                catalogTp: validSigTp,
              });
              // Send to all Telegram-enabled users
              const db2 = await getDb();
              if (db2) {
                const tgUsers = await db2.select({ userId: userSettings.userId, telegramChatId: userSettings.telegramChatId })
                  .from(userSettings)
                  .where(and(eq(userSettings.telegramEnabled, 1), isNotNull(userSettings.telegramChatId)));
                for (const tgUser of tgUsers) {
                  if (tgUser.telegramChatId) {
                    await sendTelegramMessage(msg, tgUser.telegramChatId);
                  }
                }
                const ownerInSettings = tgUsers.some(u => u.telegramChatId === OWNER_CHAT_ID);
                if (!ownerInSettings && OWNER_CHAT_ID) {
                  await sendTelegramMessage(msg, OWNER_CHAT_ID);
                }
              } else if (OWNER_CHAT_ID) {
                await sendTelegramMessage(msg, OWNER_CHAT_ID);
              }
              console.log(`[TaseAnalyze] 🔔 BUY SIGNAL sent: ${ticker} @ $${ziv.price.toFixed(2)} | Ziv=${score.toFixed(1)} | Entry=$${recommendedBuyPrice.toFixed(2)}`);
              // Increment daily TASE counter
              _taseSignalCount = _taseSignalCount + 1;
            }
            } // end daily TASE cap check
            } // end TASE hours check
          }
        }
      } catch (err: any) {
        skipped++;
      }

      // Rate limiting: every 3 tickers, pause 500ms
      if (i > 0 && i % 3 === 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[TaseAnalyze] ✅ Done in ${elapsed}s — scored ${scored}, skipped ${skipped}, hot signals: ${hotCount}`);
  } catch (err: any) {
    console.error("[TaseAnalyze] Error:", err.message);
  } finally {
    taseAnalyzeRunning = false;
  }
}

/**
 * checkPeriodicTaseAnalyzeTime — called every 5 minutes.
 * If we're in TASE market hours and at a 20-min mark, triggers runTaseAnalyze.
 * TASE hours: Mon-Thu 10:00-17:30, Fri 10:00-14:30 Israel time.
 * Closed: Sat, Sun.
 */
function checkPeriodicTaseAnalyzeTime() {
  const now = new Date();
  const ilMs = now.getTime() + 3 * 3600 * 1000;
  const il = new Date(ilMs);
  const israelDay = il.getUTCDay(); // 0=Sun, 6=Sat
  const israelHour = il.getUTCHours();
  const israelMinute = il.getUTCMinutes();
  const israelTotalMin = israelHour * 60 + israelMinute;

  // TASE closed on Sat(6) and Sun(0)
  if (israelDay === 0 || israelDay === 6) return;

  // TASE hours: Mon-Thu 10:00-17:30, Fri 10:00-14:30
  const taseOpen = 10 * 60; // 10:00
  const taseClose = israelDay === 5 ? 14 * 60 + 30 : 17 * 60 + 30; // Fri 14:30, Mon-Thu 17:30
  if (israelTotalMin < taseOpen || israelTotalMin >= taseClose) return;

  const slot = Math.floor(israelMinute / 20);
  const slotMinute = israelMinute % 20;
  if (slotMinute < 5) {
    const slotKey = 100 + israelHour * 10 + slot; // offset by 100 to avoid collision with US slot keys
    if (lastTaseAnalyzeSlot !== slotKey) {
      lastTaseAnalyzeSlot = slotKey;
      const slotLabel = slot === 0 ? "00" : slot === 1 ? "20" : "40";
      console.log(`[PeriodicTaseAnalyze] 🕐 Triggering TASE Analyze at ${israelHour}:${slotLabel} Israel time (day=${israelDay})`);
      runTaseAnalyze().catch(e => console.error("[PeriodicTaseAnalyze] Error:", e));
    }
  }
}

// Singleton guard — prevents multiple poller instances when tsx watch restarts the module.
// Uses process-level global so it persists across hot-module reloads (module-level vars reset).
declare global { var __alertPollerStarted: boolean | undefined; }

export { runDailyBasePriceSnapshot };

export function startAlertPoller() {
  if (!BOT_TOKEN || !OWNER_CHAT_ID) {
    console.log("[AlertPoller] Telegram not configured — skipping poller startup");
    return;
  }
  // Delegate to async function so we can await the DB lock check before starting intervals
  _startAlertPollerAsync().catch(e => console.error("[AlertPoller] Startup error:", e));
}

async function _startAlertPollerAsync() {
  // ── DB-level distributed lock ─────────────────────────────────────────────
  // Prevents multiple instances (from tsx watch restarts) from running concurrently.
  // Uses a heartbeat row in paperEnginelock table. If a fresh heartbeat exists
  // (< 45 seconds old), another instance is already running — skip startup.
  const LOCK_STALE_MS = 45_000;
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Random jitter 0-3s to prevent simultaneous lock acquisition by multiple restarts
  const jitter = Math.floor(Math.random() * 3000);
  await new Promise(r => setTimeout(r, jitter));

  try {
    const db = await getDb();
    if (db) {
      const now = Date.now();
      const existing = await db.execute(sql`SELECT instanceId, heartbeatAt FROM paperEnginelock WHERE id = 1 LIMIT 1`);
      const rawRows = (existing as unknown as { rows?: unknown[] }).rows ?? [];
      const rows = rawRows as Array<{ instanceId: string; heartbeatAt: string | number }>;
      if (rows.length > 0 && (now - Number(rows[0].heartbeatAt)) < LOCK_STALE_MS) {
        console.log(`[AlertPoller] DB lock held by instance ${rows[0].instanceId} (${Math.round((now - Number(rows[0].heartbeatAt)) / 1000)}s ago) — skipping duplicate startup`);
        return; // another instance is running — abort ALL intervals
      }
      // Claim the lock
      await db.execute(sql`INSERT INTO paperEnginelock (id, instanceId, heartbeatAt) VALUES (1, ${instanceId}, ${now}) ON DUPLICATE KEY UPDATE instanceId = ${instanceId}, heartbeatAt = ${now}`);
      console.log(`[AlertPoller] DB lock acquired by instance ${instanceId}`);
      // Keep lock fresh every 15s
      setInterval(async () => {
        try {
          const hbDb = await getDb();
          if (hbDb) await hbDb.execute(sql`UPDATE paperEnginelock SET heartbeatAt = ${Date.now()} WHERE id = 1 AND instanceId = ${instanceId}`);
        } catch { /* non-fatal */ }
      }, HEARTBEAT_INTERVAL_MS);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[AlertPoller] DB lock check failed — proceeding anyway:", e);
    import("./persistentLogger").then(({ dbLog: _dbLog }) => {
      _dbLog("error", "ALERTS", `AlertPoller DB lock check failed: ${msg}`, { stack });
    }).catch(() => {});
  }
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`[AlertPoller] Started — daily summary at 09:00, H2 snapshot at 19:00 Israel time`);
  setInterval(() => checkDailySummaryTime(), 5 * 60 * 1000);
  // ── Auto TP Sync: every 15 min during market hours ──────────────────────
  async function runAutoTpSync() {
    if (!isUsOpen()) return;
    // Skip silently when IBKR is manually disconnected — check DB directly (cache may be stale on boot)
    const { refreshIbindDisconnectFlag } = await import("./routers/ibkrProxy");
    const isManuallyDisconnected = await refreshIbindDisconnectFlag();
    if (isManuallyDisconnected) return;
    try {
      const db = await getDb();
      if (!db) return;
      const { ibindRequest } = await import("./routers/ibkrProxy");
      const { livePositions: lp, ibkrConidCache, liveEngineConfig: lec } = await import("../drizzle/schema");
      const { eq, and, inArray } = await import("drizzle-orm");

      // Get all users with live engine enabled
      const configs = await db.select().from(lec).where(eq(lec.isEnabled, 1));
      for (const cfg of configs) {
        const positions = await db.select().from(lp)
          .where(and(eq(lp.userId, cfg.userId), eq(lp.status, "open")));
        if (positions.length === 0) continue;

        const ordersRes = await ibindRequest("GET", "/orders");
        const activeOrders: any[] = ordersRes.ok ? ((ordersRes.body as any)?.orders ?? []) : [];

        for (const pos of positions) {
          if (!pos.currentTp || pos.currentTp <= 0) continue;
          // Check if TP order already exists on IBKR
          const existingTp = activeOrders.filter((o: any) => {
            const isTicker = (o.ticker ?? o.description1 ?? "").toUpperCase() === pos.ticker.toUpperCase();
            const rawType  = (o.orderType ?? "").toLowerCase();
            const isLmt    = rawType === "lmt" || rawType === "limit";
            const isSell   = (o.side ?? "").toUpperCase().startsWith("S");
            return isTicker && isLmt && isSell &&
              ["PreSubmitted","Submitted"].includes(o.status);
          });
          if (existingTp.length > 0) continue; // already has TP

          // Place missing TP
          const conidRows = await db.select().from(ibkrConidCache)
            .where(eq(ibkrConidCache.symbol, pos.ticker)).limit(1);
          const conid = conidRows[0]?.conid;
          if (!conid) continue;

          const isShort = pos.direction === "short";
          const exitSide = isShort ? "BUY" : "SELL";
          const tpPrice = +pos.currentTp!.toFixed(2);
          const slPrice = pos.currentSl ? +pos.currentSl.toFixed(2) : null;

          // ── Detect existing standalone SL for this position ─────────────────
          const existingSl = activeOrders.filter((o: any) => {
            const isTicker = (o.ticker ?? o.description1 ?? "").toUpperCase() === pos.ticker.toUpperCase();
            const rawType  = (o.orderType ?? "").toLowerCase();
            const isStp    = rawType === "stp" || rawType === "stop";
            const isCorrectSide = (o.side ?? "").toUpperCase().startsWith(exitSide[0]);
            return isTicker && isStp && isCorrectSide &&
              ["PreSubmitted","Submitted"].includes(o.status);
          });
          const standaloneSl = existingSl[0];

          // ── OCA-upgrade: standalone SL exists → cancel + re-issue as OCA-pair ──
          // ⚠️ GUARD (2026-06-22): NEVER cancel a bracket SL.
          // A bracket SL is one where ibkrEntryOrderId is set AND the SL orderId
          // matches pos.ibkrSlOrderId — meaning warEngine created it as part of a
          // bracket order. Cancelling it leaves the position unprotected.
          const isBracketSl =
            !!pos.ibkrEntryOrderId &&
            pos.ibkrSlOrderId != null &&
            standaloneSl?.orderId?.toString() === pos.ibkrSlOrderId?.toString();

          if (standaloneSl && slPrice && !isBracketSl) {
            const slOrdId = standaloneSl.orderId?.toString();
            console.log(`[AutoTpSync] OCA-upgrade for ${pos.ticker}: cancelling SL ${slOrdId} to place OCA-pair`);
            const cancelRes = await ibindRequest("DELETE", `/orders/${slOrdId}`, undefined, { "X-Confirm-Live-Order": "yes" });
            if (!cancelRes.ok) {
              console.warn(`[AutoTpSync] ⚠️ Could not cancel SL ${slOrdId} for ${pos.ticker} — skipping OCA`);
              continue;
            }
            await new Promise(r => setTimeout(r, 300));

            const ocaRes = await ibindRequest("POST", "/orders/oca-pair", {
              conid, side: exitSide, quantity: pos.units,
              tpPrice, slPrice, tif: "GTC",
            }, { "X-Confirm-Live-Order": "yes" });

            if (ocaRes.ok) {
              const ocaBody = ocaRes.body as any;
              const tpId  = ocaBody?.tp_order_id ?? ocaBody?.result?.[0]?.order_id?.toString() ?? null;
              const slId  = ocaBody?.sl_order_id ?? ocaBody?.result?.[1]?.order_id?.toString() ?? null;
              await db.update(lp).set({ ibkrTpOrderId: tpId, ibkrSlOrderId: slId } as any).where(eq(lp.id, pos.id));
              console.log(`[AutoTpSync] ✅ OCA-pair placed for ${pos.ticker} TP=${tpId} SL=${slId}`);
            } else {
              const errBody = ocaRes.body as any;
              console.warn(`[AutoTpSync] ❌ OCA-pair failed for ${pos.ticker}: ${errBody?.error ?? errBody?.message ?? 'unknown'}`);
            }

          } else if (isBracketSl) {
            // Bracket SL is intact — just place standalone TP for this position
            console.log(`[AutoTpSync] ${pos.ticker} has bracket SL (${pos.ibkrSlOrderId}) — skipping OCA-upgrade, placing standalone TP`);
          } else {
            // ── No standalone SL → place standalone TP (position has no SL yet or
            //    SL is already part of a bracket — standalone TP works in this case) ──
            const tpRes = await ibindRequest("POST", "/orders/take-profit", {
              conid, side: exitSide,
              quantity: pos.units, limitPrice: tpPrice, tif: "GTC",
            }, { "X-Confirm-Live-Order": "yes" });

            if (tpRes.ok) {
              const tpOrderId = (tpRes.body as any)?.result?.order_id?.toString()
                             ?? (tpRes.body as any)?.order_id?.toString() ?? null;
              if (tpOrderId) {
                await db.update(lp).set({ ibkrTpOrderId: tpOrderId }).where(eq(lp.id, pos.id));
                console.log(`[AutoTpSync] ✅ TP placed for ${pos.ticker} @ ${tpPrice} orderId=${tpOrderId}`);
              }
            } else {
              const errBody = tpRes.body as any;
              console.warn(`[AutoTpSync] ❌ TP failed for ${pos.ticker}: ${errBody?.error ?? 'HTTP ' + tpRes.status}`);
            }
          }
        }
      }
    } catch(e) {
      console.error("[AutoTpSync] Error:", e instanceof Error ? e.message : e);
    }
  }

  // Run auto TP sync every 15 minutes during market hours
  setTimeout(() => runAutoTpSync(), 60_000); // first run 1 min after start
  setInterval(() => runAutoTpSync(), 15 * 60 * 1000);
  console.log("[AlertPoller] Auto TP sync scheduled every 15 min");

  setInterval(() => checkH2SnapshotTime(), 5 * 60 * 1000);
  // ── Auto-refresh H2 crypto prices every 5 min (crypto trades 24/7) ──
  setInterval(() => refreshH2CryptoPrices(), 5 * 60 * 1000);
  setTimeout(() => refreshH2CryptoPrices(), 30_000); // initial refresh 30s after startup
  setInterval(() => checkDailyBasePriceTime(), 5 * 60 * 1000);
  setInterval(() => checkDailyJournalTime(), 5 * 60 * 1000); // A5: trading journal 23:10 IL
  setInterval(() => checkDailyVipRefreshTime(), 5 * 60 * 1000); // Dynamic VIP tiers 17:00 IL
  // ── Auto-sync IBKR live positions → portfolioHoldings every 15 min ──────
  setInterval(() => runLiveIbkrSync().catch(e => console.warn("[LiveSync] Error:", e)), 15 * 60 * 1000);
  setTimeout(() => runLiveIbkrSync().catch(e => console.warn("[LiveSync] Initial error:", e)), 10_000); // run 10s after startup
  // ── Periodic Analyze All: every 5 min during 16:30-23:00 Israel time ──
  setTimeout(() => { checkPeriodicAnalyzeTime().catch(e => console.warn("[PeriodicAnalyze] tick error:", e)); }, 5_000); // fire immediately on startup
  setInterval(() => { checkPeriodicAnalyzeTime().catch(e => console.warn("[PeriodicAnalyze] tick error:", e)); }, 5 * 60 * 1000);

  // ── Elza Live Engine — IBKR Sync (every 60s during US or TASE RTH) ───────
  // TASE: Mon–Thu 10:00–17:30, Fri 10:00–14:30 IL | US: 09:30–16:00 ET
  const IBKR_SYNC_MS = 60_000;
  const tickIbkrSync = async () => {
    try {
      if (!isIbkrSyncMarketOpen()) return;

      const { runIbkrSync } = await import("./ibkrSync");
      const result = await runIbkrSync(1);
      if (result.closedByFill > 0 || result.cancelledOrphans > 0) {
        console.log(`[ibkrSync] ${result.closedByFill} closed by fill, ${result.cancelledOrphans} orphans cancelled`);
      }
    } catch (e) {
      console.error("[ibkrSync] Error:", e);
    }
  };
  setTimeout(tickIbkrSync, 10_000);
  setInterval(tickIbkrSync, IBKR_SYNC_MS);

  // ── Intraday Armed-Watcher — 75s tick (BUILD-spec F4b; INERT until flag=1) ────
  // Detection/timing only: watches Tier-4 LONG candidates approaching the prior-day
  // Donchian-20 breakout line and, on a CONFIRMED 5m-hold + RVOL, triggers the SAME
  // validated war-engine entry path off-cadence (the watcher itself never sizes or
  // places an order — see intradayArmedWatcher.ts). Guards, in order:
  //   1. market-open (reuses the same RTH guard as tickIbkrSync — no off-hours load),
  //   2. NOT overlapping a universe/war scan (hourlyAnalyzeRunning reentrancy interlock),
  //   3. _watcherRunning latch so a 75s tick never stacks on a slow predecessor.
  // The FLAG itself is read at the TOP of runArmedWatcherTick — flag=0 ⇒ it returns
  // immediately before ANY fetch/state-mutation, so this interval is byte-identical to
  // a no-op today. The 60s cross-check reuses the tickIbkrSync quote cache (no new /quotes).
  const ARMED_WATCHER_MS = 60_000;  // owner 2026-06-30: 75s→60s
  const tickArmedWatcher = async () => {
    try {
      if (!isIbkrSyncMarketOpen()) { console.log("[AW-HB] skip: market-closed guard"); return; }
      if (hourlyAnalyzeRunning) { console.log("[AW-HB] skip: hourlyAnalyzeRunning STUCK (universe scan interlock)"); return; }
      if (_watcherRunning) { console.log("[AW-HB] skip: prev tick still running"); return; }
      _watcherRunning = true;
      try {
        const { runArmedWatcherTick } = await import("./intradayArmedWatcher");
        await runArmedWatcherTick(1);             // flag=0 ⇒ early-returns (inert)
        console.log("[AW-HB] tick RAN ok");
      } finally {
        _watcherRunning = false;
      }
    } catch (e) {
      _watcherRunning = false;
      console.warn("[ArmedWatcher] tick error:", e);
    }
  };
  setTimeout(tickArmedWatcher, 20_000);
  setInterval(tickArmedWatcher, ARMED_WATCHER_MS);

  // ── Phoenix Protocol 5m watcher — 60s tick (INERT until phoenixProtocolEnabled=1) ──
  // The flag is read at the TOP of runPhoenixWatcherTick — flag=0 ⇒ it returns immediately
  // before ANY fetch/DB/order, so this interval is byte-identical to a no-op today. Acquires
  // the shared entrySlotLock so it never double-fires with the war cycle / Armed-Watcher.
  let _phoenixWatcherRunning = false;
  const tickPhoenixWatcher = async () => {
    try {
      if (!isIbkrSyncMarketOpen()) return;
      if (_phoenixWatcherRunning) return;
      _phoenixWatcherRunning = true;
      try {
        const { runPhoenixWatcherTick } = await import("./phoenixProtocol");
        await runPhoenixWatcherTick(1);
      } finally {
        _phoenixWatcherRunning = false;
      }
    } catch (e) {
      _phoenixWatcherRunning = false;
      console.warn("[PhoenixWatcher] tick error:", e);
    }
  };
  setTimeout(tickPhoenixWatcher, 25_000);
  setInterval(tickPhoenixWatcher, 60_000);

  // ── THE WAITER — retest resting-LMT tick — 75s (INERT until waiterEnabled=1) ──────
  // The flag is read at the TOP of runWaiterTick — flag=0 ⇒ it returns IMMEDIATELY before
  // ANY candidate load / order / DB write / extra fetch, so this interval is byte-identical
  // to a no-op today. When ON it (1) MANAGES the resting/filled Waiter book first (never-
  // naked / falling-knife / EOD / R2 re-quote), then (2) places new resting LMTs for fresh
  // GOLD_RETEST_WAR candidates under the shared entrySlotLock (atomic slot + 30% sub-cap +
  // shared optimistic-BP). Market-open guarded + a reentrancy latch so a 75s tick never
  // stacks on a slow predecessor. Mirrors tickArmedWatcher / tickPhoenixWatcher exactly.
  let _waiterWatcherRunning = false;
  const WAITER_TICK_MS = 75_000;
  const tickWaiter = async () => {
    try {
      if (!isIbkrSyncMarketOpen()) return;
      if (_waiterWatcherRunning) return;
      _waiterWatcherRunning = true;
      try {
        const { runWaiterTick } = await import("./waiterEngine");
        await runWaiterTick(1);                 // flag=0 ⇒ early-returns (inert)
      } finally {
        _waiterWatcherRunning = false;
      }
    } catch (e) {
      _waiterWatcherRunning = false;
      console.warn("[Waiter] tick error:", e);
    }
  };
  setTimeout(tickWaiter, 30_000);
  setInterval(tickWaiter, WAITER_TICK_MS);

  // ── SL/TP Enforcement CRON (every 5 min, market hours) — full sync ───────
  // Same logic as War Room "סנכרן SL/TP" button (orphans + qty fix + place missing)
  setInterval(async () => {
    try {
      if (!isIbkrSyncMarketOpen()) return;

      const { runLiveSlTpEnforcement } = await import("./liveSlTpEnforcement");
      const result = await runLiveSlTpEnforcement(1, "CRON");
      if (result.placed > 0 || result.qtyFixed > 0 || result.orphansCancelled > 0 || result.failed > 0) {
        console.log(`[SL_TP_ENFORCEMENT] [CRON] ${result.message}`);
      }
    } catch (e) {
      console.error("[SL_TP_ENFORCEMENT] [CRON] Error:", e);
    }
  }, 5 * 60 * 1000);

  // ── Periodic TASE Analyze: check every 5 min, triggers every 20 min during 10:00-17:00 Israel ──
  setInterval(() => checkPeriodicTaseAnalyzeTime(), 5 * 60 * 1000);
  // ── Auto-fill conid cache on startup (60s delay to let IBKR Gateway connect) ──
  setTimeout(async () => {
    try {
      const { ibindRequest } = await import("./routers/ibkrProxy");
      const { ibkrConidCache, userAssets } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return;
      const rows = await db.selectDistinct({ ticker: userAssets.ticker }).from(userAssets).where(eq(userAssets.archived, 0));
      const allTickers = rows.map(r => r.ticker.toUpperCase());
      const cachedRows = await db.select({ symbol: ibkrConidCache.symbol }).from(ibkrConidCache);
      const cachedSet = new Set(cachedRows.map(r => r.symbol.toUpperCase()));
      const UNTRADEABLE = new Set(["TA-BANKS.TA", "TA-INS.TA", "ENERGEAN.TA", "TA-35.TA", "TA-125.TA", "TA-90.TA", "TRX.TA", "KSTN.TA", "ESTATE15.TA", "PHINERGY.TA", "ACCL.TA", "NTO.TA", "KRDI.TA", "NIKE"]);
      const TICKER_CORRECTIONS: Record<string, string> = { "NIKE": "NKE" };
      const missing = allTickers.filter(t => !cachedSet.has(t) && !UNTRADEABLE.has(t));
      if (missing.length === 0) {
        console.log(`[ConidAutoFill] All ${allTickers.length} tickers already cached ✅`);
        return;
      }
      console.log(`[ConidAutoFill] ${missing.length} tickers missing conids: [${missing.join(", ")}] — starting auto-fill via Live Gateway...`);
      let resolved = 0, failed = 0;
      const BATCH = 5;
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH);
        const ibkrBatch = batch.map(s => {
          const base = s.replace(/\.TA$/i, '');
          return TICKER_CORRECTIONS[base] ?? base;
        });
        try {
          const res = await ibindRequest('GET', `/trsrv/stocks?symbols=${ibkrBatch.join(',')}`);
          if (res.ok) {
            const data = res.body as Record<string, any[]>;
            for (let j = 0; j < batch.length; j++) {
              const origSym = batch[j];
              const ibkrSym = ibkrBatch[j];
              const entries: any[] = data[ibkrSym] ?? data[origSym] ?? [];
              const contract = entries.find((e: any) => e.assetClass === 'STK') ?? entries[0];
              if (contract?.conid) {
                await db.insert(ibkrConidCache).values({
                  symbol: origSym, conid: Number(contract.conid),
                  exchange: contract.primaryExch ?? contract.listingExchange ?? null,
                  currency: contract.currency ?? null,
                  assetClass: contract.assetClass ?? 'STK',
                  resolvedAt: Date.now(),
                }).onDuplicateKeyUpdate({ set: { conid: Number(contract.conid), resolvedAt: Date.now() } });
                resolved++;
              } else { failed++; }
            }
          } else { failed += batch.length; }
        } catch { failed += batch.length; }
        if (i + BATCH < missing.length) await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[ConidAutoFill] Complete: ${resolved} resolved, ${failed} failed, ${allTickers.length - missing.length} already cached`);
    } catch (err) {
      console.error('[ConidAutoFill] Auto-fill failed:', err);
    }
  }, 60_000); // 60s delay for IBKR Gateway to connect

}

// Export for manual trigger via tRPC

// ── Auto-Sync: IBKR Live positions → portfolioHoldings DB ──────────────────
// Runs every 15 minutes to keep Holding 1 in sync with real IBKR account.
// When market is closed and IBKR returns position=0, DB is cleared accordingly.
let _lastLiveSyncTs = 0;
const LIVE_SYNC_INTERVAL_MS = 15 * 60_000; // 15 minutes

async function runLiveIbkrSync(): Promise<void> {
  const now = Date.now();
  if (now - _lastLiveSyncTs < LIVE_SYNC_INTERVAL_MS) return;
  _lastLiveSyncTs = now;
  try {
    const db = await getDb();
    if (!db) return;

    // Fetch live positions from ibind (port 5000, Live account)
    const IBIND_LIVE_SECRET = process.env.IBIND_API_SECRET ?? "";
    const livePos: any[] = await new Promise((resolve) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: 5000,
        path: "/positions",
        method: "GET",
        headers: { Authorization: `Bearer ${IBIND_LIVE_SECRET}` },
        timeout: 8000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed?.positions) ? parsed.positions : []);
          } catch { resolve([]); }
        });
      });
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
      req.end();
    });

    if (!livePos.length) return; // ibind unreachable — skip

    // Get owner userId
    const ownerUserId = 1;

    const { fetchOpenLivePositionsByTicker, mergeIbkrHoldingWithLive } = await import("./portfolioHoldingsSync");
    const liveByTicker = await fetchOpenLivePositionsByTicker(db, ownerUserId);

    // Filter positions with qty > 0
    const activeTickers = new Set(
      livePos.filter((p: any) => Math.abs(p.position ?? 0) > 0).map((p: any) =>
        (p.contractDesc ?? p.ticker ?? "").toUpperCase()
      )
    );

    // Delete from DB tickers no longer in IBKR (closed positions)
    const existing = await db.select({ id: portfolioHoldings.id, ticker: portfolioHoldings.ticker })
      .from(portfolioHoldings)
      .where(eq(portfolioHoldings.userId, ownerUserId));

    for (const row of existing) {
      if (!activeTickers.has(row.ticker.toUpperCase())) {
        await db.delete(portfolioHoldings).where(eq(portfolioHoldings.id, row.id));
        console.log(`[LiveSync] 🗑 Removed closed position: ${row.ticker}`);
      }
    }

    // Upsert active positions
    for (const p of livePos) {
      const qty = p.position ?? 0;
      if (Math.abs(qty) === 0) continue;
      const ticker = (p.contractDesc ?? p.ticker ?? "").toUpperCase();
      if (!ticker) continue;

      const existingRow = existing.find(r => r.ticker.toUpperCase() === ticker);
      const mktPrice = p.mktPrice ?? p.avgCost ?? 0;
      const avgCost  = p.avgCost ?? mktPrice;
      const merged = mergeIbkrHoldingWithLive(ticker, {
        position: qty,
        avgCost,
        mktPrice,
      }, liveByTicker);

      if (existingRow) {
        const updateSet: Record<string, unknown> = {
          units: merged.units,
          buyPrice: merged.buyPrice,
          currentPrice: mktPrice,
          updatedAt: new Date(),
        };
        if (merged.stopLoss != null) updateSet.stopLoss = merged.stopLoss;
        if (merged.takeProfit != null) updateSet.takeProfit = merged.takeProfit;
        if (merged.source) updateSet.source = merged.source;
        await db.update(portfolioHoldings)
          .set(updateSet)
          .where(eq(portfolioHoldings.id, existingRow.id));
      } else {
        await db.insert(portfolioHoldings).values({
          userId: ownerUserId,
          ticker,
          units: merged.units,
          buyPrice: merged.buyPrice,
          currentPrice: mktPrice,
          ...(merged.stopLoss != null ? { stopLoss: merged.stopLoss } : {}),
          ...(merged.takeProfit != null ? { takeProfit: merged.takeProfit } : {}),
          ...(merged.source ? { source: merged.source } : {}),
        });
        console.log(`[LiveSync] ➕ Added new position: ${ticker} × ${merged.units} @ $${merged.buyPrice.toFixed(2)}`);
      }
    }

    console.log(`[LiveSync] ✅ IBKR Live sync complete — ${activeTickers.size} active positions`);
  } catch (e: any) {
    console.warn(`[LiveSync] ⚠️ Error: ${e.message}`);
  }
}

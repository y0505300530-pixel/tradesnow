/**
 * Telegram Bot Webhook Handler
 * POST /api/telegram/webhook
 *
 * Handles incoming messages from Telegram users.
 * Supported commands:
 *   /holdings  — show all open positions with price, TP, SL, and a short summary
 *   /alerts    — show active (untriggered) price alerts
 *   /summary   — on-demand portfolio summary (same as daily 09:00 summary)
 *   /help      — list all available commands
 */

import { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { portfolioHoldings, priceAlerts, userSettings, userAssets, masterKnowledge, localUsers, deepAnalysisCache } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { fetchLivePricesBatch, fetchLivePrice, fetchBarsForTicker } from "../marketData";
import { sendTelegramMessage } from "../telegram";
import { invokeLLM } from "../_core/llm";
import { ENV } from "../_core/env";
import { log } from "../logger";
import { calcZivEngineScore, calcRSI, calcEMA } from "../zivEngine";

/** Resolve the owner's userId from OWNER_OPEN_ID — cached after first call.
 *  Falls back to userId=1 (first registered user = owner) if env is not set. */
let _ownerUserId: number | undefined = undefined;
async function getOwnerUserId(): Promise<number> {
  if (_ownerUserId !== undefined) return _ownerUserId;
  if (ENV.ownerOpenId) {
    const user = await getUserByOpenId(ENV.ownerOpenId);
    if (user?.id) { _ownerUserId = user.id; return _ownerUserId; }
  }
  // Safety fallback: OWNER_OPEN_ID not set or user not found — use userId=1
  log.warn("TELEGRAM", "OWNER_OPEN_ID not resolved — falling back to userId=1");
  _ownerUserId = 1;
  return _ownerUserId;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/** Validate Telegram webhook secret_token header (set via setWebhook). */
function isValidTelegramWebhookSecret(req: Request): boolean {
  const expected = ENV.telegramWebhookSecret.trim();
  if (!expected) {
    log.warn("TELEGRAM", "TELEGRAM_WEBHOOK_SECRET not set — rejecting webhook request");
    return false;
  }
  const header = req.headers["x-telegram-bot-api-secret-token"];
  return typeof header === "string" && header === expected;
}

/** Verify that the incoming message is from the authorised chat.
 *  Allows: (1) the owner's TELEGRAM_CHAT_ID env var,
 *          (2) any localUser whose telegramChatId matches. */
async function isAuthorised(chatId: string | number): Promise<boolean> {
  if (!chatId) return false;
  // Always allow the owner
  if (OWNER_CHAT_ID && String(chatId) === String(OWNER_CHAT_ID)) return true;
  // Check if any localUser has this chatId registered
  const db = await getDb();
  if (!db) return false;
  const match = await db
    .select({ id: localUsers.id })
    .from(localUsers)
    .where(eq(localUsers.telegramChatId, String(chatId)))
    .limit(1);
  return match.length > 0;
}

/** Resolve userId from a Telegram chatId — checks localUsers first, then falls back to owner */
async function getUserIdFromChatId(chatId: string | number): Promise<number> {
  const db = await getDb();
  if (db) {
    const match = await db
      .select({ linkedUserId: localUsers.linkedUserId })
      .from(localUsers)
      .where(eq(localUsers.telegramChatId, String(chatId)))
      .limit(1);
    if (match.length > 0 && match[0].linkedUserId) return match[0].linkedUserId;
  }
  return getOwnerUserId();
}

/** Send a reply back to the Telegram chat */
async function reply(chatId: string | number, text: string): Promise<void> {
  await sendTelegramMessage(text, String(chatId));
}
async function sendTyping(chatId: string | number): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch { /* non-blocking */ }
}

// ─── Ticker Context Fetcher ─────────────────────────────────────────────────

// Common company name → ticker aliases
const COMPANY_ALIASES: Record<string, string> = {
  GOOGLE: "GOOGL", ALPHABET: "GOOGL",
  APPLE: "AAPL",
  MICROSOFT: "MSFT",
  AMAZON: "AMZN",
  META: "META", FACEBOOK: "META",
  NETFLIX: "NFLX",
  TESLA: "TSLA",
  NVIDIA: "NVDA",
  PALANTIR: "PLTR",
  SEAGATE: "STX",
  MARVELL: "MRVL",
  BROADCOM: "AVGO",
  QUALCOMM: "QCOM",
  AMD: "AMD",
  INTEL: "INTC",
  SALESFORCE: "CRM",
  SNOWFLAKE: "SNOW",
  COINBASE: "COIN",
  SHOPIFY: "SHOP",
  UBER: "UBER",
  AIRBNB: "ABNB",
  SPOTIFY: "SPOT",
  TWITTER: "X",
  CHEVRON: "CVX",
  EXXON: "XOM",
  JPMORGAN: "JPM",
  GOLDMAN: "GS",
  BERKSHIRE: "BRK.B",
};

/**
 * Detect ticker from message: bare ticker, company name alias, or ticker embedded in Hebrew sentence.
 * e.g. "STX", "Google", "מה המצב של NVDA?", "ניתוח של Seagate"
 */
function extractTicker(text: string): string | null {
  const clean = text.trim().toUpperCase();
  // 1. Bare ticker (1-5 letters, optional suffix like .B)
  if (/^[A-Z]{1,5}([./][A-Z]{1,2})?$/.test(clean)) return clean;
  // 2. Company name alias (whole word match)
  for (const [name, ticker] of Object.entries(COMPANY_ALIASES)) {
    if (new RegExp(`\\b${name}\\b`).test(clean)) return ticker;
  }
  // 3. Ticker embedded in sentence: "מה המצב של NVDA" or "ניתוח STX"
  const match = clean.match(/\b([A-Z]{2,5})\b/);
  return match ? match[1] : null;
}

/**
 * Fetch real-time context for a ticker: live price, asset catalogue data, active signal.
 * Returns a formatted string to inject into the AI system prompt.
 */
async function fetchTickerContext(ticker: string, userId?: number): Promise<string> {
  const sections: string[] = [];

  // ── 1. Full ZIV Engine Technical Analysis ──────────────────────────────────
  try {
    const bars = await fetchBarsForTicker(ticker, 420);
    if (bars && bars.length >= 50) {
      const closes = bars.map(b => b.close);
      const ziv = calcZivEngineScore(bars);
      const rsi = calcRSI(closes);
      // ATR-14
      const trs = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
      const atr14 = trs.slice(-14).reduce((a: number, b: number) => a + b, 0) / 14;
      // Stop Loss: lower of ATR×1.5 or EMA-50×0.97
      const atrStop = ziv.price - atr14 * 1.5;
      const emaStop = ziv.ema50 * 0.97;
      const stopLoss = Math.max(atrStop, emaStop); // take the higher (less risk)
      const stopLossPct = ((ziv.price - stopLoss) / ziv.price * 100);
      // Take Profit: entry + 2.5× risk
      const risk = ziv.price - stopLoss;
      const takeProfit = ziv.price + risk * 2.5;
      // Volume ratio
      const volumes = bars.map(b => b.volume ?? 0);
      const avgVol20 = volumes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
      const avgVol5 = volumes.slice(-5).reduce((a: number, b: number) => a + b, 0) / 5;
      const volRatio = avgVol20 > 0 ? (avgVol5 / avgVol20) : 1;
      // Donchian 52-week high
      const high52w = Math.max(...bars.slice(-252).map(b => b.high));
      const low52w = Math.min(...bars.slice(-252).map(b => b.low));
      // EMA-20
      const ema20 = calcEMA(closes, 20);
      const tierEmoji = ziv.tier === "Gold Breakout" ? "🔥" : ziv.tier === "Gold Retest" ? "⭐" : ziv.tier === "Near Entry Watch" ? "⚪" : "❌";
      sections.push(
`═══════════════════════════════
📊 ניתוח טכני מלא: ${ticker}
═══════════════════════════════
${tierEmoji} ציון ZIV: ${ziv.score.toFixed(2)}/10 — ${ziv.tier}
💹 מחיר: $${ziv.price.toFixed(2)}
📉 EMA-20: $${ema20.toFixed(2)} | EMA-50: $${ziv.ema50.toFixed(2)} | EMA-200: $${ziv.ema200.toFixed(2)}
📈 Donchian-20 High: $${ziv.donchian20High.toFixed(2)}
📊 RSI-14: ${rsi.toFixed(1)} ${rsi >= 40 && rsi <= 70 ? "✅" : rsi > 70 ? "⚠️ OVERBOUGHT" : "⚠️ OVERSOLD"}
📦 Volume Ratio (5d/20d): ${volRatio.toFixed(2)}x ${volRatio >= 1.2 ? "✅ חזק" : volRatio < 0.8 ? "⚠️ חלש" : "⚪ רגיל"}
🕯️ Price Action: ${ziv.priceAction ?? "None"}
📅 52W High: $${high52w.toFixed(2)} | 52W Low: $${low52w.toFixed(2)}
🛑 SL מומלץ: $${stopLoss.toFixed(2)} (${stopLossPct.toFixed(1)}% מהמחיר)
   • ATR×1.5: $${atrStop.toFixed(2)} | EMA-50×0.97: $${emaStop.toFixed(2)}
🎯 TP מומלץ (R/R=2.5:1): $${takeProfit.toFixed(2)}
💡 סיבה: ${ziv.reason}`);
    }
  } catch { /* non-blocking */ }

  // ── 2. Asset Catalogue data from DB ───────────────────────────────────────
  try {
    const db = await getDb();
    if (db) {
      const ownerUserId = userId ?? await getOwnerUserId();
      const assets = await db.select().from(userAssets)
        .where(and(eq(userAssets.userId, ownerUserId), eq(userAssets.ticker, ticker)));
      const asset = assets[0];
      if (asset) {
        const catalogLines: string[] = [];
        if (asset.score != null) catalogLines.push(`ציון ZIV: ${Number(asset.score).toFixed(1)}/10`);
        if (asset.tier) catalogLines.push(`Tier: ${asset.tier}`);
        if (asset.recommendation) catalogLines.push(`Signal: ${asset.recommendation}`);
        if (asset.hotSignal) catalogLines.push(`🔥 Hot Signal: כן`);
        if (asset.recommendedBuyPrice) catalogLines.push(`כניסה מומלצת: $${Number(asset.recommendedBuyPrice).toFixed(2)}`);
        if (asset.recommendedStopLoss) catalogLines.push(`SL מומלץ: $${Number(asset.recommendedStopLoss).toFixed(2)}`);
        if (asset.profitPotential) catalogLines.push(`פוטנציאל רווח: ${Number(asset.profitPotential).toFixed(1)}%`);
        if (asset.reason) catalogLines.push(`סיבה: ${asset.reason}`);
        if (asset.note) catalogLines.push(`הערת משתמש: ${asset.note}`);
        if (catalogLines.length > 0) sections.push(`📋 קטלוג נכסים (${asset.companyName}):\n${catalogLines.join("\n")}`);
      }
    }
  } catch { /* non-blocking */ }

  // ── 3. Active signal from Master Knowledge ────────────────────────────────
  try {
    const db = await getDb();
    if (db) {
      const ownerUserId = userId ?? await getOwnerUserId();
      const mkRows = await db.select().from(masterKnowledge).where(eq(masterKnowledge.userId, ownerUserId));
      const mk = mkRows[0];
      if (mk?.activeSignals) {
        const signals: any[] = JSON.parse(mk.activeSignals);
        const sig = signals.find((s: any) => s.ticker?.toUpperCase() === ticker);
        if (sig) {
          const sigLines: string[] = [];
          if (sig.entry) sigLines.push(`כניסה: $${sig.entry}`);
          if (sig.stopLoss) sigLines.push(`SL: $${sig.stopLoss}`);
          if (sig.takeProfit) sigLines.push(`TP: $${sig.takeProfit}`);
          if (sig.catalyst) sigLines.push(`קטליסט: ${sig.catalyst}`);
          if (sig.status) sigLines.push(`סטטוס: ${sig.status}`);
          if (sigLines.length > 0) sections.push(`🚦 איתות פעיל מ-Master Knowledge:\n${sigLines.join(" | ")}`);
        }
      }
    }
  } catch { /* non-blocking */ }

  // ── 4. Deep Analysis Cache ────────────────────────────────────────────────────
  try {
    const db = await getDb();
    if (db) {
      // Get the most recent deep analysis for this ticker (any cache key)
      const rows = await db
        .select()
        .from(deepAnalysisCache)
        .where(eq(deepAnalysisCache.ticker, ticker.toUpperCase()))
        .orderBy(deepAnalysisCache.createdAt)
        .limit(1);
      if (rows.length > 0) {
        const cached = JSON.parse(rows[0].result) as any;
        const ai = cached?.ai;
        const meta = cached;
        const ageHours = Math.round((Date.now() - new Date(rows[0].createdAt).getTime()) / 3_600_000);
        const deepLines: string[] = [];
        if (meta?.score != null) deepLines.push(`ZIV Score: ${Number(meta.score).toFixed(2)} — ${meta.tier ?? ""}`);
        if (meta?.recommendedBuyPrice) deepLines.push(`כניסה מומלצת: $${Number(meta.recommendedBuyPrice).toFixed(2)}`);
        if (meta?.stopLoss) deepLines.push(`SL מנוע: $${Number(meta.stopLoss).toFixed(2)} (${Number(meta.stopLossPct ?? 0).toFixed(1)}%)`);
        if (meta?.positionSizeUsd) deepLines.push(`גודל פוזיציה מומלץ: $${Number(meta.positionSizeUsd).toFixed(0)} (${meta.positionSizePct ?? ""}%)`);
        if (meta?.positionSizeRationale) deepLines.push(`נימוק גודל: ${meta.positionSizeRationale}`);
        if (ai?.recommendation) deepLines.push(`\n🎯 המלצה: ${ai.recommendation}`);
        if (ai?.summary) deepLines.push(`📝 סיכום: ${ai.summary}`);
        if (ai?.positionRationale) deepLines.push(`💡 נימוק: ${ai.positionRationale}`);
        if (ai?.risks) deepLines.push(`⚠️ סיכונים: ${ai.risks}`);
        if (ai?.actionTrigger) deepLines.push(`🔔 טריגר לפעולה: ${ai.actionTrigger}`);
        if (deepLines.length > 0) {
          sections.push(`🔬 Deep Analysis (לפני ${ageHours}h):\n${deepLines.join("\n")}`);
        }
      }
    }
  } catch { /* non-blocking */ }

  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// ─── Command Handlers ────────────────────────────────────────────────────────

/**
 * /holdings — list all open positions
 * Format per holding:
 *   🔵 AAPL  $185.40  (+1.2% today)
 *      💰 P&L: +12.5%  |  Score: 8.26
 *      🛑 SL: $170.00  |  🎯 TP: $210.00
 *      📝 Strong uptrend, EMA-50 support holding
 */
async function handleHoldings(chatId: string | number): Promise<void> {
  const db = await getDb();
  if (!db) { await reply(chatId, "❌ Database unavailable"); return; }

  const ownerUserId = await getUserIdFromChatId(chatId);
  const holdings = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId));
  if (holdings.length === 0) {
    await reply(chatId, "📭 <b>אין פוזיציות פתוחות כרגע.</b>");
    return;
  }

  const tickers = Array.from(new Set(holdings.map(h => h.ticker)));
  const livePricesMap = await fetchLivePricesBatch(tickers);

  // Generate short summaries via LLM for all holdings at once
  let summaryMap: Record<string, string> = {};
  try {
    const holdingDescriptions = holdings.map(h => {
      const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
      const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
      const pnlPct = ((price - h.buyPrice) / h.buyPrice) * 100;
      return `${h.ticker}: price=$${price.toFixed(2)}, P&L=${pnlPct.toFixed(1)}%, score=${h.zivScore ?? "N/A"}, tier=${h.entryTier ?? "N/A"}`;
    }).join("\n");

    const llmRes = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a concise trading assistant. For each stock ticker provided, write a SHORT summary in Hebrew of maximum 10 words describing the current situation. Return ONLY a JSON object where keys are ticker symbols and values are the Hebrew summaries. Example: {\"AAPL\": \"מגמה עולה חזקה, מחזיק מעל EMA-50\"}"
        },
        {
          role: "user",
          content: `Generate 10-word Hebrew summaries for these holdings:\n${holdingDescriptions}`
        }
      ],
      response_format: { type: "json_object" }
    });
    const rawContent = llmRes?.choices?.[0]?.message?.content ?? "{}";
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
    summaryMap = JSON.parse(content);
  } catch {
    // If LLM fails, use fallback summaries based on score
    for (const h of holdings) {
      const score = h.zivScore ?? 0;
      summaryMap[h.ticker] = score >= 8 ? "מגמה חזקה, מחזיק יפה" :
                              score >= 6 ? "מגמה ניטרלית, מעקב נדרש" :
                              "מגמה חלשה, שקול יציאה";
    }
  }

  const rows: string[] = [];
  let totalValue = 0;
  let totalCost = 0;

  for (const h of holdings) {
    const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
    const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
    const dailyPct = lp?.changePercent ?? h.dailyChangePercent ?? 0;
    const pnlPct = ((price - h.buyPrice) / h.buyPrice) * 100;
    const value = price * h.units;
    const cost = h.buyPrice * h.units;
    totalValue += value;
    totalCost += cost;

    const priceEmoji = dailyPct >= 0 ? "🟢" : "🔴";
    const pnlEmoji = pnlPct >= 0 ? "✅" : "⚠️";
    const scoreStr = h.zivScore != null ? `Score: ${h.zivScore.toFixed(2)}` : "";
    const slStr = h.stopLoss != null ? `🛑 SL: $${h.stopLoss.toFixed(2)}` : "🛑 SL: —";
    const tpStr = h.takeProfit != null ? `🎯 TP: $${h.takeProfit.toFixed(2)}` : "🎯 TP: —";
    const summary = summaryMap[h.ticker] ?? "";

    rows.push([
      `${priceEmoji} <b>${h.ticker}</b>  $${price.toFixed(2)}  (${dailyPct >= 0 ? "+" : ""}${dailyPct.toFixed(2)}% today)`,
      `   ${pnlEmoji} P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%  |  ${scoreStr}`,
      `   ${slStr}  |  ${tpStr}`,
      summary ? `   📝 <i>${summary}</i>` : "",
    ].filter(Boolean).join("\n"));
  }

  const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

  const msg = [
    `📋 <b>trade-snow2.vip — Holdings (${holdings.length})</b>`,
    ``,
    rows.join("\n\n"),
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `💼 שווי תיק: $${totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    `💰 P&L כולל: ${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%`,
  ].join("\n");

  await reply(chatId, msg);
}

/**
 * /alerts — list all active (untriggered) price alerts
 */
async function handleAlerts(chatId: string | number): Promise<void> {
  const db = await getDb();
  if (!db) { await reply(chatId, "❌ Database unavailable"); return; }

  const activeAlerts = await db
    .select()
    .from(priceAlerts)
    .where(and(eq(priceAlerts.triggered, 0), eq(priceAlerts.dismissed, 0)));

  if (activeAlerts.length === 0) {
    await reply(chatId, "✅ <b>אין התראות פעילות כרגע.</b>");
    return;
  }

  // Fetch live prices for context
  const tickers = Array.from(new Set(activeAlerts.map(a => a.ticker)));
  const livePricesMap = await fetchLivePricesBatch(tickers);

  const rows: string[] = [];
  for (const a of activeAlerts) {
    const lp = livePricesMap.get(a.ticker.toUpperCase()) ?? livePricesMap.get(a.ticker);
    const currentPrice = lp?.price;
    const typeEmoji = a.alertType === "sl" ? "🛑" : a.alertType === "tp" ? "🎯" : "🔔";
    const label = a.label ?? (a.alertType === "sl" ? "Stop Loss" : a.alertType === "tp" ? "Take Profit" : "Custom");
    const dirStr = a.direction === "below" ? "⬇️ מתחת ל-" : "⬆️ מעל ל-";
    const priceStr = currentPrice != null
      ? `  (עכשיו: $${currentPrice.toFixed(2)})`
      : "";
    rows.push(`${typeEmoji} <b>${a.ticker}</b> — ${label}\n   ${dirStr}$${Number(a.targetPrice).toFixed(2)}${priceStr}`);
  }

  const msg = [
    `🔔 <b>trade-snow2.vip — התראות פעילות (${activeAlerts.length})</b>`,
    ``,
    rows.join("\n\n"),
  ].join("\n");

  await reply(chatId, msg);
}

/**
 * /summary — on-demand portfolio summary (same format as daily 09:00)
 */
async function handleSummary(chatId: string | number): Promise<void> {
  const db = await getDb();
  if (!db) { await reply(chatId, "❌ Database unavailable"); return; }

  const ownerUserId2 = await getUserIdFromChatId(chatId);
  const holdings = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId2));
  if (holdings.length === 0) {
    await reply(chatId, "📭 <b>אין פוזיציות פתוחות כרגע.</b>");
    return;
  }

  const tickers = Array.from(new Set(holdings.map(h => h.ticker)));
  const livePricesMap = await fetchLivePricesBatch(tickers);

  let totalValue = 0;
  let totalCost = 0;
  let weightedDailyChange = 0;
  const rows: string[] = [];

  for (const h of holdings) {
    const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
    const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
    const dailyPct = lp?.changePercent ?? h.dailyChangePercent ?? 0;
    const value = price * h.units;
    const cost = h.buyPrice * h.units;
    const pnlPct = ((price - h.buyPrice) / h.buyPrice) * 100;
    totalValue += value;
    totalCost += cost;
    weightedDailyChange += dailyPct * value;

    const dailyEmoji = dailyPct >= 0 ? "🟢" : "🔴";
    const pnlEmoji = pnlPct >= 0 ? "✅" : "⚠️";
    const holdingValue = value.toLocaleString("en-US", { maximumFractionDigits: 0 });
    rows.push(
      `${dailyEmoji} <b>${h.ticker}</b> (${dailyPct >= 0 ? "+" : ""}${dailyPct.toFixed(2)}% today)` +
      `\n   ${pnlEmoji} P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% · 💵 $${holdingValue}`
    );
  }

  const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;
  const avgDailyChange = totalValue > 0 ? weightedDailyChange / totalValue : 0;
  const dateStr = new Date().toLocaleDateString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const msg = [
    `📊 <b>trade-snow2.vip — סיכום תיק</b>`,
    `<i>${dateStr}</i>`,
    ``,
    rows.join("\n\n"),
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `💼 <b>שווי תיק:</b> $${totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    `📈 <b>שינוי יומי:</b> ${avgDailyChange >= 0 ? "+" : ""}${avgDailyChange.toFixed(2)}%`,
    `💰 <b>P&L כולל:</b> ${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%`,
  ].join("\n");

  await reply(chatId, msg);
}

/**
 * /help — list all available commands
 */
async function handleHelp(chatId: string | number): Promise<void> {
  const msg = [
    `🤖 <b>trade-snow2.vip Bot — פקודות זמינות</b>`,
    ``,
    `📊 /summary — סיכום תיק מידי`,
    `❓ /help — רשימת פקודות`,
    ``,
    `🧠 <b>צאט חופשי:</b> שלח כל שאלה בעברית והמנוע יענה אותך!`,
    `<i>לדוגמא: "מה המצב של NVDA?" או "איפה לשים SL על TSLA?"</i>`,
  ].join("\n");
  await reply(chatId, msg);
}

// ─── Telegram AI Chat (free-text messages) ───────────────────────────────────────────

// Per-chat conversation history (in-memory, resets on server restart)
const chatHistories = new Map<string | number, Array<{ role: "user" | "assistant"; content: string }>>();
const MAX_HISTORY = 20; // keep last 20 turns

/**
 * handleAIChat — routes free-text Telegram messages to the Ziv Engine AI.
 * The AI knows the full methodology, risk rules, and current portfolio context.
 */
async function handleAIChat(chatId: string | number, userText: string): Promise<void> {
  // Detect if user is asking about a specific ticker and fetch real-time data
  let tickerContext = "";
  const detectedTicker = extractTicker(userText);
  const resolvedUserId = await getUserIdFromChatId(chatId);
  if (detectedTicker) {
    tickerContext = await fetchTickerContext(detectedTicker, resolvedUserId);
  }
  // ── Proactive Catalogue Context ─────────────────────────────────────────────
  // When no specific ticker is detected, inject the full catalogue so the AI
  // can answer open-ended questions like "מה לקנות?" or "מה הכי מעניין עכשיו?"
  let catalogueContext = "";
  try {
    const db = await getDb();
    if (db) {
      const goldAssets = await db
        .select()
        .from(userAssets)
        .where(
          and(
            eq(userAssets.userId, resolvedUserId),
            eq(userAssets.archived, 0)
          )
        )
        .orderBy(userAssets.score);
      const goldTiers = goldAssets.filter(a => a.tier === "Gold Breakout" || a.tier === "Gold Retest");
      const otherTiers = goldAssets.filter(a => a.tier !== "Gold Breakout" && a.tier !== "Gold Retest" && a.score != null && Number(a.score) >= 6);
      const allRelevant = [...goldTiers, ...otherTiers].slice(0, 20);
      if (allRelevant.length > 0) {
        const rows = allRelevant.map(a => {
          const tierEmoji = a.tier === "Gold Breakout" ? "🔥" : a.tier === "Gold Retest" ? "⭐" : "⚪";
          const parts = [`${tierEmoji} ${a.ticker} (${a.companyName}) — ZIV: ${Number(a.score ?? 0).toFixed(1)}/10 | ${a.tier ?? "N/A"}` ];
          if (a.recommendedBuyPrice) parts.push(`כניסה: $${Number(a.recommendedBuyPrice).toFixed(2)}`);
          if (a.recommendedStopLoss) parts.push(`SL: $${Number(a.recommendedStopLoss).toFixed(2)}`);
          if (a.profitPotential) parts.push(`פוטנציאל: ${Number(a.profitPotential).toFixed(0)}%`);
          if (a.hotSignal) parts.push(`🔥 HOT SIGNAL`);
          if (a.reason) parts.push(`סיבה: ${a.reason}`);
          if (a.note) parts.push(`הערה: ${a.note}`);
          return parts.join(" | ");
        });
        catalogueContext = `\n\n═══════════════════════════════\n📋 קטלוג נכסים — הזדמנויות עכשיו (${goldTiers.length} Gold, ${otherTiers.length} Watch):\n═══════════════════════════════\n${rows.join("\n")}`;
      }
    }
  } catch { /* non-blocking */ }
  // Fetch current portfolio for context
  let portfolioContext = "";
  try {
    const db = await getDb();
    if (db) {
      const ownerUserId = resolvedUserId;
      const holdings = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId));
      if (holdings.length > 0) {
        const tickers = Array.from(new Set(holdings.map(h => h.ticker)));
        const livePricesMap = await fetchLivePricesBatch(tickers);
        const rows = holdings.map(h => {
          const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
          const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
          const pnlPct = ((price - h.buyPrice) / h.buyPrice) * 100;
          return `${h.ticker}: ${h.units} shares @ $${h.buyPrice.toFixed(2)} | now $${price.toFixed(2)} | P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% | SL $${h.stopLoss?.toFixed(2) ?? "N/A"} | TP $${h.takeProfit?.toFixed(2) ?? "N/A"} | Score ${h.zivScore?.toFixed(1) ?? "N/A"} (${h.entryTier ?? "N/A"})`;
        });
        portfolioContext = `\n\nCURRENT PORTFOLIO (${holdings.length} positions):\n${rows.join("\n")}`;
      }
    }
  } catch { /* non-blocking */ }

  const SYSTEM_PROMPT = `You are the Ziv Trading Engine AI — a professional, opinionated trading advisor operating via Telegram.
You were built by the user to embody their specific trading methodology.
You have two responsibilities:
1. KNOW the user's methodology and risk rules deeply — never contradict them without strong evidence.
2. STAND YOUR GROUND — if the user proposes something that violates the engine's rules, push back clearly.

═══════════════════════════════════════════
🏗️ THE ZIV ENGINE — CORE METHODOLOGY
═══════════════════════════════════════════

📊 SCORING (0–10): 9–10=🔥 Gold Breakout (Donchian+volume) | 7–8=🔄 Gold Retest (EMA-50 bounce) | 5–6=📍 Near Entry Watch | 1–4=❌ No Signal (avoid)

🛑 STOP LOSS: ATR-14×1.5 below entry OR EMA-50×0.97 (take lower). Never widen beyond 10%. Gold Breakout: Winner's Leash 25% trailing.

🎯 TAKE PROFIT: Default = Entry + 2.5× risk (R/R=2.5:1). Gold Breakout: let it run. Never set TP below 1.5× risk.

💰 POSITION SIZING (1% Risk Rule): Shares = (Portfolio×1%) ÷ (Entry−SL). Tier caps: 🔥 Hot ≤20% | ⭐ Tier-1 ≤10% | ⚪ Tier-2 ≤5% | ❌ skip.

🚪 EXIT PROTOCOLS:
• ZIM Protocol: 7 consecutive closes below EMA-50 → EXIT FULL
• Diamond Hands: 5 consecutive closes below EMA-20 → REDUCE
• Trash Tier: score 1–4 → EXIT immediately
• Max 2 trades per ticker — stopped out twice = no re-entry

🧠 PHILOSOPHY: Trend following. EMA-200 = bull/bear line. Volume confirms. ATR-based stops. 1% risk per trade. Cut losers fast, let winners run. Never average down.
${portfolioContext}
═══════════════════════════════════════════
RULES FOR THIS CONVERSATION:
1. RESPOND IN HEBREW — always.
2. Be DIRECT and OPINIONATED — say what you think, not what the user wants to hear.
3. Push back if the user violates risk rules.
4. Keep responses CONCISE — 2–3 sentences max. No bullet lists unless specifically asked. No essays. No greetings.
5. End with a CLEAR RECOMMENDATION when relevant.
6. If asked about a specific stock, use the portfolio context above.
7. You are NOT a generic chatbot — you are the user's trading engine.
8. When real-time ticker data is provided below, USE IT to give a concrete, data-driven answer. Do NOT say you lack data.
9. When asked "מה לקנות?", "מה מעניין?", "מה הכי חזק?", "מה הזדמנויות?" — IMMEDIATELY use the catalogue data below and list the top Gold Breakout/Retest stocks with their entry prices. Never say you lack data.
10. Be PROACTIVE — if you see a Hot Signal or a Gold Breakout in the catalogue, mention it even if not asked directly.${tickerContext}${catalogueContext}`;

  // Get or create conversation history for this chat
  const history = chatHistories.get(chatId) ?? [];

  // Build messages array
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-MAX_HISTORY),
    { role: "user", content: userText },
  ];

  log.info("TELEGRAM", "AI chat request", { chatId: String(chatId), msgLen: userText.length, historyLen: history.length });
  try {
    // Send typing indicator instead of a separate message
    await sendTyping(chatId);
    const llmResp = await invokeLLM({ messages, max_tokens: 400 } as any);
    const aiReply = llmResp?.choices?.[0]?.message?.content ?? "לא הצלחתי לעבד את הבקשה. נסה שוב.";
    const replyText = typeof aiReply === "string" ? aiReply : JSON.stringify(aiReply);

    log.debug("TELEGRAM", "AI chat response sent", { chatId: String(chatId), replyLen: replyText.length });

    // Update history
    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: replyText });
    // Keep only last MAX_HISTORY turns
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    chatHistories.set(chatId, history);

    await reply(chatId, replyText);
  } catch (err: any) {
    log.error("TELEGRAM", "AI chat error", { chatId: String(chatId), error: err?.message });
    await reply(chatId, "❌ שגיאה בתקשורת עם המנוע. נסה שוב.");
  }
}

// ─── Message Debounce ────────────────────────────────────────────────────────
// ALL messages go through a 2-second debounce window.
// Rapid-fire messages ("?", "!", follow-up questions) are combined into one AI call.
// The typing indicator is sent immediately so the user knows the bot is alive.
const pendingMessages = new Map<string | number, { texts: string[]; timer: ReturnType<typeof setTimeout>; typingSent: boolean }>();
const DEBOUNCE_MS = 2000; // 2s window — collect all messages in this window

async function queueOrProcess(chatId: string | number, text: string): Promise<void> {
  const existing = pendingMessages.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.texts.push(text);
    // Send typing again to keep the indicator alive
    void sendTyping(chatId);
  } else {
    // First message in window — send typing immediately so user knows bot is alive
    void sendTyping(chatId);
    pendingMessages.set(chatId, { texts: [text], timer: null as any, typingSent: true });
  }
  const entry = pendingMessages.get(chatId)!;
  entry.timer = setTimeout(async () => {
    const combined = entry.texts.join(" ").trim();
    pendingMessages.delete(chatId);
    if (combined) {
      await handleAIChat(chatId, combined);
    }
  }, DEBOUNCE_MS);
}

// ─── Register Webhook Route ───────────────────────────────────────────────────
export function registerTelegramWebhookRoute(app: Express): void {
  app.post("/api/telegram/webhook", async (req: Request, res: Response) => {
    if (!isValidTelegramWebhookSecret(req)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    // Always respond 200 immediately so Telegram doesn't retry
    res.json({ ok: true });

    try {
      const update = req.body;
      const message = update?.message ?? update?.edited_message;
      if (!message) return;

      const chatId = message.chat?.id;
      const text: string = (message.text ?? "").trim();

      // Ignore empty messages or messages without a chat
      if (!chatId || !text) return;

      // Security: only respond to the configured owner chat
      if (!await isAuthorised(chatId)) {
        log.warn("TELEGRAM", `Unauthorised chat blocked`, { chatId: String(chatId) });
        await reply(chatId, "🚫 גישה נדחתה. בוט זה פרטי.");
        return;
      }

      if (text.startsWith("/")) {
        const command = text.split(" ")[0].toLowerCase().replace(/@.*$/, "");
        log.info("TELEGRAM", `Command received`, { command, chatId: String(chatId) });

        switch (command) {
          case "/holdings": await handleHoldings(chatId); break;
          case "/alerts":   await handleAlerts(chatId);   break;
          case "/summary":  await handleSummary(chatId);  break;
          case "/help":     await handleHelp(chatId);     break;
          default:
            log.warn("TELEGRAM", `Unknown command`, { command, chatId: String(chatId) });
            await reply(chatId, `❓ פקודה לא מוכרת: <code>${command}</code>\n\nשלח /help לרשימת פקודות.`);
        }
      } else {
        // Free-text message — debounce and route to Ziv Engine AI
        log.info("TELEGRAM", `Free-text AI chat`, { chatId: String(chatId), preview: text.slice(0, 60) });
        await queueOrProcess(chatId, text);
      }
    } catch (err: any) {
      log.error("TELEGRAM", "Error handling Telegram update", { error: err?.message });
    }
  });
}

/**
 * Register bot commands with Telegram so they appear in the menu.
 * Called once on server startup.
 */
export async function registerBotCommands(): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    const commands = [
      { command: "summary",  description: "סיכום תיק מידי" },
      { command: "help",     description: "רשימת פקודות" },
    ];
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    const data = await res.json() as { ok: boolean };
    if (data.ok) {
      console.log("[TelegramWebhook] Bot commands registered successfully");
    } else {
      console.warn("[TelegramWebhook] Failed to register bot commands:", data);
    }
  } catch (err) {
    console.warn("[TelegramWebhook] Could not register bot commands:", err);
  }
}

/**
 * Set the webhook URL with Telegram so it forwards messages to our server.
 * Called once on server startup when TELEGRAM_WEBHOOK_URL env var is set.
 */
export async function setTelegramWebhook(webhookUrl: string): Promise<void> {
  if (!BOT_TOKEN) return;
  const secretToken = ENV.telegramWebhookSecret.trim();
  if (!secretToken) {
    console.warn("[TelegramWebhook] TELEGRAM_WEBHOOK_SECRET not set — webhook will reject all requests until configured");
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message"],
        ...(secretToken ? { secret_token: secretToken } : {}),
      }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (data.ok) {
      console.log(`[TelegramWebhook] Webhook set to: ${webhookUrl}`);
    } else {
      console.warn("[TelegramWebhook] Failed to set webhook:", data.description);
    }
  } catch (err) {
    console.warn("[TelegramWebhook] Could not set webhook:", err);
  }
}

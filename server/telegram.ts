/**
 * Telegram Bot Helper
 * Sends notifications to the owner's Telegram chat via @PollyGray_Blitzzbot
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramMessage(text: string, chatId?: string): Promise<boolean> {
  const token = TELEGRAM_BOT_TOKEN;
  const chat = chatId ?? TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, parse_mode: "HTML", text }),
    });
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Format an alert message in the new clean template:
 *
 * 🔔 trade-snow2.vip — BUY Alert
 *
 * Ticker: ZIM
 * Alert: @ $25.88
 * Current Price: $25.67 (-1.31% today)
 * Status: ⬇️ hit or below
 *
 * ⭐ Ziv Score: 8.5
 *
 * alertType:
 *   "sl"     → SL Alert (🔴)
 *   "tp"     → TP Alert (🟢)
 *   "custom" → BUY Alert (🔔)
 */
export function formatAlertMessage(opts: {
  ticker: string;
  alertType: "sl" | "tp" | "custom" | "short";
  targetPrice: number;
  currentPrice: number;
  changePercent?: number | null;
  zivScore?: number | null;
  /** Optional prefix line shown before the headline (e.g. "📢 איתות מהמנהל" for broadcast) */
  broadcastPrefix?: string | null;
  /** Optional SL price from catalog */
  catalogSl?: number | null;
  /** Optional TP price (calculated from entry + 2.5*(entry-SL)) */
  catalogTp?: number | null;
  /** v16.4.2: Portfolio name (Holding 1 / H2 TASE / H2 USA / H2 Crypto) */
  portfolioName?: string | null;
  /** v16.4.2: P&L string e.g. "+$1,234 (+5.2%)" */
  pnlStr?: string | null;
}): string {
  const { ticker, alertType, targetPrice, currentPrice, changePercent, zivScore, broadcastPrefix, catalogSl, catalogTp, portfolioName, pnlStr } = opts;

  // Headline label per alert type
  const headlineEmoji = alertType === "sl" ? "🔴" : alertType === "tp" ? "🟢" : alertType === "short" ? "🐻" : "🔔";
  const headlineLabel = alertType === "sl" ? "SL Alert" : alertType === "tp" ? "TP Alert" : alertType === "short" ? "SHORT Signal" : "BUY Alert";

  // Alert line label
  const alertLineLabel = alertType === "sl" ? "SL" : alertType === "tp" ? "TP" : alertType === "short" ? "SHORT Entry" : "BUY";

  // Direction
  const direction = currentPrice <= targetPrice ? "⬇️ hit or below" : "⬆️ hit or above";

  // Change percent string
  const pctStr = changePercent != null
    ? ` (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}% today)`
    : "";

  // Ziv Score line
  const scoreEmoji = zivScore != null
    ? (zivScore >= 10 ? "⚡" : zivScore >= 9 ? "🔥" : "⭐")
    : "⭐";
  const scoreLine = zivScore != null
    ? `\n${scoreEmoji} <b>Ziv Score: ${zivScore.toFixed(1)}</b>`
    : "";

  // No comment line on live alerts
  const buyComment = "";

  // SL/TP lines from catalog (BUY/custom + SHORT alerts)
  const slTpLines = (alertType === "custom" || alertType === "short")
    ? [
        catalogSl != null ? `\n🛑 <b>SL:</b> $${catalogSl.toFixed(2)}` : "",
        catalogTp != null ? `\n🎯 <b>TP:</b> $${catalogTp.toFixed(2)}` : "",
      ].filter(Boolean).join("")
    : "";

  // Optional broadcast prefix (shown as first line)
  const prefixLine = broadcastPrefix ? `${broadcastPrefix}\n\n` : "";

  // v16.4.2: Portfolio name line
  const portfolioLine = portfolioName ? `\n📁 <b>Portfolio:</b> ${portfolioName}` : "";
  // v16.4.2: P&L line
  const pnlLine = pnlStr ? `\n💰 <b>P&L:</b> ${pnlStr}` : "";

  return [
    `${prefixLine}${headlineEmoji} <b>${headlineLabel}</b>`,
    ``,
    `<b>Ticker:</b> ${ticker}`,
    `<b>Alert:</b> ${alertLineLabel} @ $${targetPrice.toFixed(2)}`,
    `<b>Current Price:</b> $${currentPrice.toFixed(2)}${pctStr}${slTpLines}`,
    `${portfolioLine}${pnlLine}`,
    `${buyComment}`,
    scoreLine,
  ].join("\n");
}

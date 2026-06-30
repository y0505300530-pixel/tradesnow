/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                    SHORT GUARD v1.0                                  ║
 * ║  Safety guards for short positions:                                  ║
 * ║    1. Short Squeeze Protection (>3% adverse move)                    ║
 * ║    2. Dividend Guard (block entry 2 days before Ex-Div Date)         ║
 * ║    3. Earnings Blackout (block entry 3 days before/after earnings)   ║
 * ║    4. Wide Lung Short (trail EMA-20 from above at 8% profit)         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

export interface ShortGuardResult {
  blocked: boolean;
  reason: string;
  action: "BLOCK_ENTRY" | "EXIT_NOW" | "ALLOW";
}

// ─── Dividend Guard ────────────────────────────────────────────────────────────
// Block short entry if Ex-Dividend Date is within 2 trading days.
// IBKR will charge you the dividend if you're short on Ex-Div date.
export function checkDividendGuard(
  ticker: string,
  entryDate: string,
  exDivDate: string | null
): ShortGuardResult {
  if (!exDivDate) return { blocked: false, reason: "", action: "ALLOW" };

  const entry = new Date(entryDate).getTime();
  const exDiv = new Date(exDivDate).getTime();
  const diffDays = (exDiv - entry) / (1000 * 60 * 60 * 24);

  // Block if Ex-Div is within 2 calendar days
  if (diffDays >= 0 && diffDays <= 2) {
    return {
      blocked: true,
      reason: `🚫 Dividend Guard: Ex-Dividend date is ${diffDays.toFixed(0)} day(s) away (${exDivDate}). Blocked — IBKR charges dividend on short positions held through Ex-Div.`,
      action: "BLOCK_ENTRY",
    };
  }

  return { blocked: false, reason: "", action: "ALLOW" };
}

// ─── Earnings Blackout ─────────────────────────────────────────────────────────
// Block short entry within 3 days before OR after earnings date.
// Earnings gaps can be +20-40% overnight, instantly blowing through SL.
export function checkEarningsBlackout(
  ticker: string,
  tradeDate: string,
  earningsDate: string | null
): ShortGuardResult {
  if (!earningsDate) return { blocked: false, reason: "", action: "ALLOW" };

  const trade    = new Date(tradeDate).getTime();
  const earnings = new Date(earningsDate).getTime();
  const diffDays = Math.abs(trade - earnings) / (1000 * 60 * 60 * 24);

  if (diffDays <= 3) {
    return {
      blocked: true,
      reason: `🚫 Earnings Blackout: ${ticker} earnings on ${earningsDate} — within ${diffDays.toFixed(0)} day(s). Gap risk is too high for short positions.`,
      action: "BLOCK_ENTRY",
    };
  }

  return { blocked: false, reason: "", action: "ALLOW" };
}

// ─── Short Squeeze Exit ────────────────────────────────────────────────────────
// Exit immediately if the position has moved > 3% against us (from entry price).
// This is measured from entry price (not intraday) to avoid noise.
export function checkShortSqueezeExit(
  ticker: string,
  entryPrice: number,
  currentPrice: number
): ShortGuardResult {
  const lossPct = ((currentPrice - entryPrice) / entryPrice) * 100;

  if (lossPct > 3.0) {
    return {
      blocked: true,
      reason: `⚡ Short Squeeze: ${ticker} up ${lossPct.toFixed(1)}% from entry $${entryPrice.toFixed(2)} → current $${currentPrice.toFixed(2)}. Covering immediately to prevent runaway loss.`,
      action: "EXIT_NOW",
    };
  }

  return { blocked: false, reason: "", action: "ALLOW" };
}

// ─── Wide Lung Short ───────────────────────────────────────────────────────────
// Once a short position reaches 8% profit, switch to EMA-20 trailing stop.
// For shorts: we trail from ABOVE (stop = EMA-20, exit if price closes ABOVE EMA-20).
// This lets winners run while protecting accumulated profit.
export function checkWideLungShort(
  currentProfitPct: number,
  currentPrice: number,
  ema20: number,
  wideLungActive: boolean
): { activate: boolean; exit: boolean; reason: string } {
  // Activate Wide Lung at 8% profit
  if (!wideLungActive && currentProfitPct >= 8) {
    return {
      activate: true, exit: false,
      reason: `💪 Wide Lung SHORT: 8% profit reached (${currentProfitPct.toFixed(1)}%). Trailing on EMA-20 from above.`,
    };
  }

  // ELZA 2.0 #5 — REJECT EMA-based exits. The former "close above EMA-20 → exit"
  // branch is removed: structural trail (Open Skies Stage 2 chandelier) is the
  // sole exit authority. (This function is currently unwired/dead; neutralized so
  // it can never re-introduce an EMA exit if wired later.)
  void ema20; void currentPrice;
  return { activate: false, exit: false, reason: "" };
}

// ─── Combined Short Guard Check ────────────────────────────────────────────────
// Run all guards in sequence — returns first blocking result or ALLOW.
export function runShortGuards(params: {
  ticker: string;
  tradeDate: string;
  entryPrice: number;
  currentPrice: number;
  exDivDate: string | null;
  earningsDate: string | null;
}): ShortGuardResult {
  const { ticker, tradeDate, entryPrice, currentPrice, exDivDate, earningsDate } = params;

  // 1. Dividend Guard (most critical — real financial loss)
  const divCheck = checkDividendGuard(ticker, tradeDate, exDivDate);
  if (divCheck.blocked) return divCheck;

  // 2. Earnings Blackout (gap risk)
  const earningsCheck = checkEarningsBlackout(ticker, tradeDate, earningsDate);
  if (earningsCheck.blocked) return earningsCheck;

  // 3. Squeeze check (for open positions)
  if (currentPrice > entryPrice) {
    const squeezeCheck = checkShortSqueezeExit(ticker, entryPrice, currentPrice);
    if (squeezeCheck.blocked) return squeezeCheck;
  }

  return { blocked: false, reason: "", action: "ALLOW" };
}

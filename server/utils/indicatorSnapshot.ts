/**
 * indicatorSnapshot.ts — Pure technical-indicator math
 *
 * Extracted from paperLabEngine.ts so that live routers (analyzePosition,
 * manualOrder) can import it independently of the Paper subsystem.
 *
 * All functions here are pure (no DB / engine / network calls).
 */

const EMA50_SLOPE_LOOKBACK = 5;    // compare EMA-50 now vs 5 bars ago

/**
 * Compute EMA-50 slope from daily bars.
 * Returns the slope value (positive = uptrend, negative = downtrend).
 * Returns null if insufficient bars.
 */
function computeEma50Slope(bars: Array<{ close: number }>): number | null {
  if (bars.length < 50 + EMA50_SLOPE_LOOKBACK) return null;
  const closes = bars.map(b => b.close);
  const k50 = 2 / 51;
  // Compute EMA-50 for all bars, then compare last vs lookback-ago
  let ema50 = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
  const ema50Values: number[] = [];
  for (let i = 50; i < closes.length; i++) {
    ema50 = closes[i] * k50 + ema50 * (1 - k50);
    ema50Values.push(ema50);
  }
  if (ema50Values.length < EMA50_SLOPE_LOOKBACK) return null;
  const current = ema50Values[ema50Values.length - 1];
  const lookbackAgo = ema50Values[ema50Values.length - 1 - EMA50_SLOPE_LOOKBACK];
  return current - lookbackAgo;
}

/**
 * Compute EMA-20 from daily bars (last value).
 * Returns null if insufficient bars.
 */
function computeEma20(bars: Array<{ close: number }>): number | null {
  if (bars.length < 20) return null;
  const closes = bars.map(b => b.close);
  const k20 = 2 / 21;
  let ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) ema20 = closes[i] * k20 + ema20 * (1 - k20);
  return ema20;
}

/**
 * Compute RSI-14 from daily bars.
 * Returns RSI value (0-100), or 50 if insufficient data.
 */
function computeRSI(bars: Array<{ close: number }>, period = 14): number {
  if (bars.length < period + 1) return 50;
  const closes = bars.map(b => b.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Compute EMA-50 last value from daily bars.
 * Returns null if insufficient bars.
 */
function computeEma50Value(bars: Array<{ close: number }>): number | null {
  if (bars.length < 50) return null;
  const closes = bars.map(b => b.close);
  const k50 = 2 / 51;
  let ema50 = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
  for (let i = 50; i < closes.length; i++) ema50 = closes[i] * k50 + ema50 * (1 - k50);
  return ema50;
}

/**
 * Compute a full Point-in-Time snapshot of technical indicators.
 * Used at both entry and exit to freeze the market state.
 * Bars must already be normalised to USD.
 */
export function computeIndicatorSnapshot(bars: Array<{ close: number; volume?: number; high: number; low: number }>, currentPrice: number): {
  rsi14: number;
  ema20: number | null;
  ema50: number | null;
  ema50Slope: number | null;
  atr14: number | null;
  distFromEma20Pct: number | null;
  relativeVolume: number | null;
} {
  const rsi14 = computeRSI(bars);
  const ema20 = computeEma20(bars);
  const ema50 = computeEma50Value(bars);
  const ema50Slope = computeEma50Slope(bars);

  // ATR-14
  let atr14: number | null = null;
  if (bars.length >= 15) {
    const atrPeriod = Math.min(14, bars.length - 1);
    let atrSum = 0;
    for (let i = bars.length - atrPeriod; i < bars.length; i++) {
      const prevClose = bars[i - 1].close;
      const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
      atrSum += tr;
    }
    atr14 = atrSum / atrPeriod;
  }

  // Distance from EMA-20 %
  const distFromEma20Pct = ema20 != null && ema20 > 0
    ? ((currentPrice - ema20) / ema20) * 100
    : null;

  // Relative Volume (today's volume / 20-day average volume)
  let relativeVolume: number | null = null;
  if (bars.length >= 21) {
    const lastBar = bars[bars.length - 1];
    const prev20 = bars.slice(-21, -1);
    const avgVol = prev20.reduce((s, b) => s + (b.volume ?? 0), 0) / prev20.length;
    if (avgVol > 0 && (lastBar.volume ?? 0) > 0) {
      relativeVolume = (lastBar.volume ?? 0) / avgVol;
    }
  }

  return { rsi14, ema20, ema50, ema50Slope, atr14, distFromEma20Pct, relativeVolume };
}

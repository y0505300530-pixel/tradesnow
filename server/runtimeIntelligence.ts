/**
 * runtimeIntelligence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time market intelligence — signals a human cannot track manually.
 *
 * 1. Market Regime: SPY EMA-slope + VIX proxy → BULL / NEUTRAL / BEAR
 * 2. Multi-timeframe Confluence: score only enters if daily + weekly aligned
 * 3. Sector Rotation: which sectors accelerating vs decelerating
 * 4. Position Correlation: blocks new entry if correlation > 0.85 with existing open
 * 5. Liquidity Score: volume ratio vs 20-day avg — rejects low-liquidity entries
 * 6. Momentum Velocity: rate-of-change of score over last 3 bars
 */

import { fetchBarsForTicker } from "./marketData";
import { calcZivEngineScore, calcEMA } from "./zivEngine";

export type MarketRegime = "BULL" | "NEUTRAL" | "BEAR";

export interface RuntimeIntelligence {
  regime:           MarketRegime;
  spyEmaSlope:      number;        // weekly EMA-50 slope of SPY
  vixProxy:         number;        // SPY realized vol proxy (10-day std of daily returns)
  longOk:           boolean;       // enter longs?
  shortOk:          boolean;       // enter shorts?
  regimeReason:     string;
  breadthPctBelow200: number;      // % of scanned universe trading below its EMA-200 (prior cycle); cold-start 0.5
  /**
   * TRUE when this regime is the DEGRADED fallback (SPY fetch failed / insufficient
   * data / throw) and NOT a real market read. Consumers that fail-closed on a bad
   * VIX read (EOD overnight-gross trim) MUST treat `vixProxy` as untrustworthy when
   * this is set — the fallback's vixProxy=20 is a placeholder, not a measurement.
   */
  degraded?:        boolean;
}

// ── Breadth gate thresholds (symmetric-short spec §1.4) ──────────────────────
export const WEAK_BREADTH_PCT      = 0.55;   // ≥55% of universe below EMA-200 = bearish breadth → shorts ON even if SPY=BULL
export const STRONG_BREADTH_PCT    = 0.45;   // <45% below = healthy breadth (longs favored)
export const WEAK_BREADTH_PCT_HARD = 0.70;   // ≥70% below = broad rout → suppress new longs
const BREADTH_COLD_START           = 0.5;    // neutral until one cycle has tallied breadth

/** Read the persisted prior-cycle breadthPctBelow200 (cold-start 0.5 on miss/error). */
async function readPersistedBreadth(): Promise<number> {
  try {
    const { getDb } = await import("./db");
    const _db = await getDb();
    if (!_db) return BREADTH_COLD_START;
    const { systemSettings } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await _db.select().from(systemSettings).where(eq(systemSettings.key, "war_breadth")).limit(1);
    const raw = rows?.[0]?.value;
    if (!raw) return BREADTH_COLD_START;
    const v = Number(JSON.parse(raw)?.breadthPctBelow200);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : BREADTH_COLD_START;
  } catch {
    return BREADTH_COLD_START;
  }
}

export interface RegimeOpts {
  /** Override the persisted prior-cycle breadth (warEngine passes the freshly-tallied value). */
  breadthPctBelow200?: number;
  /** Owner knob for the weak-breadth short-enable threshold (liveEngineConfig.breadthThreshold). */
  breadthThreshold?: number;
}

export interface TickerIntelligence {
  liquidityScore:   number;        // 0-10 — relative volume vs 20d avg
  momentumVelocity: number;        // score change rate (positive = accelerating)
  weeklyAligned:    boolean;       // weekly EMA-50 slope matches daily direction
  confluenceScore:  number;        // 0-10 — how many timeframes agree
}

// ── Cache ────────────────────────────────────────────────────────────────────
let _regimeCache: RuntimeIntelligence | null = null;
let _regimeCacheAt = 0;
const REGIME_TTL = 20 * 60 * 1000; // 20 minutes

// ── Market Regime ─────────────────────────────────────────────────────────────
export async function getMarketRegime(opts: RegimeOpts = {}): Promise<RuntimeIntelligence> {
  // Breadth is a SLOW-moving regime signal computed during the PRIOR scan cycle.
  // warEngine passes the freshly-tallied value; other callers fall back to the
  // persisted prior-cycle value (cold-start 0.5). It re-gates longOk/shortOk on
  // every call (even a cache HIT) so a fresh breadth is never masked by the cache.
  const breadthPctBelow200 = opts.breadthPctBelow200 != null
    ? opts.breadthPctBelow200
    : await readPersistedBreadth();
  const breadthThreshold = opts.breadthThreshold ?? WEAK_BREADTH_PCT;

  if (_regimeCache && Date.now() - _regimeCacheAt < REGIME_TTL) {
    return applyBreadthGate(_regimeCache, breadthPctBelow200, breadthThreshold);
  }

  try {
    const bars = await fetchBarsForTicker("SPY", 120);
    if (bars.length < 60) {
      return _fallbackRegime("Insufficient SPY data");
    }

    const closes = bars.map(b => b.close);

    // Weekly EMA-50 slope: compress into weekly bars
    const weeklyCloses: number[] = [];
    for (let i = 4; i < bars.length; i += 5) weeklyCloses.push(closes[i]);
    const ema50Now  = calcEMA(weeklyCloses, Math.min(50, weeklyCloses.length));
    const ema50Prev = calcEMA(weeklyCloses.slice(0, -3), Math.min(50, weeklyCloses.length - 3));
    const spyEmaSlope = weeklyCloses.length >= 53 ? (ema50Now - ema50Prev) / ema50Prev * 100 : 0;

    // VIX proxy: 10-day realized volatility of SPY daily returns
    const last10 = closes.slice(-11);
    const dailyReturns = last10.slice(1).map((c, i) => (c - last10[i]) / last10[i]);
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const vixProxy = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length) * Math.sqrt(252) * 100;

    // Regime classification
    let regime: MarketRegime;
    let reason: string;

    if (spyEmaSlope > 0.3 && vixProxy < 25) {
      regime = "BULL";
      reason = `SPY EMA slope +${spyEmaSlope.toFixed(2)}%, realized vol ${vixProxy.toFixed(1)}%`;
    } else if (spyEmaSlope < -0.3 || vixProxy > 35) {
      regime = "BEAR";
      reason = `SPY EMA slope ${spyEmaSlope.toFixed(2)}%, realized vol ${vixProxy.toFixed(1)}%`;
    } else {
      regime = "NEUTRAL";
      reason = `SPY EMA slope ${spyEmaSlope.toFixed(2)}%, realized vol ${vixProxy.toFixed(1)}%`;
    }

    // Cache the SPY-derived regime; longOk/shortOk are (re)computed by the breadth
    // gate below so they always reflect the latest breadth even on a cache hit.
    _regimeCache = {
      regime, spyEmaSlope, vixProxy,
      longOk:  regime !== "BEAR",
      shortOk: regime !== "BULL",
      regimeReason: reason,
      breadthPctBelow200,
    };
    _regimeCacheAt = Date.now();
    return applyBreadthGate(_regimeCache, breadthPctBelow200, breadthThreshold);

  } catch (e) {
    return _fallbackRegime(String(e).slice(0, 60), breadthPctBelow200);
  }
}

/**
 * Breadth-aware long/short enablement (symmetric-short spec §1.4). Decouples
 * shortOk from the SPY-only regime: shorts are ON when breadth is weak even if
 * SPY reads BULL (the Mag7-masked tape this gate uniquely suppressed before).
 *
 *   shortOk = regime ∈ {BEAR,NEUTRAL}  OR  breadthPctBelow200 ≥ threshold(0.55)
 *   longOk  = regime ≠ BEAR            AND breadthPctBelow200 <  0.70 (broad-rout guard)
 *
 * shortOk is a regime *enabler*, not the per-trade decision — the per-ticker
 * weekly filter (intel.weeklyAligned) still governs each individual short.
 */
function applyBreadthGate(base: RuntimeIntelligence, breadthPctBelow200: number, threshold: number): RuntimeIntelligence {
  const weakBreadth = breadthPctBelow200 >= threshold;
  const broadRout   = breadthPctBelow200 >= WEAK_BREADTH_PCT_HARD;
  const longOk  = base.regime !== "BEAR" && !broadRout;
  const shortOk = base.regime === "BEAR" || base.regime === "NEUTRAL" || weakBreadth;
  const breadthNote = ` | breadth ${(breadthPctBelow200 * 100).toFixed(0)}% < EMA-200${weakBreadth ? " (WEAK → shorts ON)" : ""}${broadRout ? " (ROUT → longs OFF)" : ""}`;
  return {
    ...base,
    longOk, shortOk, breadthPctBelow200,
    regimeReason: base.regimeReason + breadthNote,
  };
}

function _fallbackRegime(reason: string, breadthPctBelow200 = BREADTH_COLD_START): RuntimeIntelligence {
  // degraded=true — vixProxy here is a PLACEHOLDER (20), not a real measurement.
  // The EOD overnight-gross trim treats this as a BAD VIX read and fails closed (0.5×).
  return { regime: "NEUTRAL", spyEmaSlope: 0, vixProxy: 20, longOk: true, shortOk: true, regimeReason: reason, breadthPctBelow200, degraded: true };
}

// ── Ticker Intelligence ───────────────────────────────────────────────────────
export async function getTickerIntelligence(
  ticker: string,
  bars?: Array<{ close: number; high: number; low: number; volume?: number }>,
): Promise<TickerIntelligence> {
  try {
    const b = bars ?? await fetchBarsForTicker(ticker, 60);
    if (b.length < 30) return { liquidityScore: 5, momentumVelocity: 0, weeklyAligned: true, confluenceScore: 5 };

    // Liquidity: relative volume (last 5 days vs 20-day avg)
    const vols = b.map(x => x.volume ?? 0).filter(v => v > 0);
    const avgVol20 = vols.slice(-20).reduce((a, v) => a + v, 0) / Math.min(20, vols.length);
    const avgVol5  = vols.slice(-5).reduce((a, v) => a + v, 0) / 5;
    const relVol = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
    const liquidityScore = Math.min(10, relVol * 5); // 1.0x relVol = score 5, 2.0x = score 10

    // Weekly alignment: compress to weekly, check EMA-50 slope
    const closes = b.map(x => x.close);
    const weeklyC: number[] = [];
    for (let i = 4; i < b.length; i += 5) weeklyC.push(closes[i]);
    const wEma = weeklyC.length >= 6
      ? calcEMA(weeklyC, Math.min(50, weeklyC.length))
      : closes[closes.length - 1];
    const wEmaPrev = weeklyC.length >= 9
      ? calcEMA(weeklyC.slice(0, -3), Math.min(50, weeklyC.length - 3))
      : wEma;
    const weeklySlope = (wEma - wEmaPrev) / wEmaPrev;
    const weeklyAligned = weeklySlope > -0.005; // positive or flat weekly

    // Momentum velocity: compare Ziv score from 3 bars ago vs now
    // Use EMA-50 distance proxy
    const ema50now  = calcEMA(closes, Math.min(50, closes.length));
    const ema50prev = calcEMA(closes.slice(0, -3), Math.min(50, closes.length - 3));
    const priceNow  = closes[closes.length - 1];
    const pricePrev = closes[closes.length - 4];
    const distNow  = (priceNow - ema50now)  / ema50now;
    const distPrev = (pricePrev - ema50prev) / ema50prev;
    const momentumVelocity = (distNow - distPrev) * 100; // positive = accelerating toward entry

    // Confluence score
    let conf = 5;
    if (weeklySlope > 0.002) conf += 2;
    if (relVol > 1.2) conf += 1.5;
    if (momentumVelocity > 0.3) conf += 1.5;

    return { liquidityScore, momentumVelocity, weeklyAligned, confluenceScore: Math.min(10, conf) };

  } catch {
    return { liquidityScore: 5, momentumVelocity: 0, weeklyAligned: true, confluenceScore: 5 };
  }
}

/** Correlation proxy between two ticker close series (last 30 bars) */
export function calcCorrelation(barsA: number[], barsB: number[], n = 30): number {
  const a = barsA.slice(-n);
  const b = barsB.slice(-n);
  if (a.length < 10 || b.length < 10) return 0;
  const len = Math.min(a.length, b.length);
  const meanA = a.slice(-len).reduce((s, v) => s + v, 0) / len;
  const meanB = b.slice(-len).reduce((s, v) => s + v, 0) / len;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < len; i++) {
    const da = a[a.length - len + i] - meanA;
    const db = b[b.length - len + i] - meanB;
    num += da * db; da2 += da * da; db2 += db * db;
  }
  return da2 > 0 && db2 > 0 ? num / Math.sqrt(da2 * db2) : 0;
}

export function invalidateRegimeCache() { _regimeCache = null; }

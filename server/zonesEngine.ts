// ─── Ziv Engine Phase 1 — Demand/Supply Zones (SSOT) ───────────────────────────
// The ONLY module allowed to compute a Zone. Refines the inline `calcZones`
// (tradeManager.ts) into a real engine: consolidation→impulse detection + touches,
// volume-at-formation, ATR-padded entry band, strength, merge/rank. Pure: bars in
// → zones out. No I/O, no DB, no clock.
//
// Spec: docs/ziv-engine-spec/phase1-ruleset.md §2, phase1-architecture.md §2.1.
// Symmetric: opts.trend "up" → demand zones, "down" → supply. Entry band uses
// DAILY ATR14 (resolved decision Q3), capped MIN 0.5% / MAX 3% (E4/E5).

import type { Bar } from "./zivEngine";

export type ZoneKind = "demand" | "supply";
export type ZoneSource = "swing" | "consolidation" | "merged";
export type ZoneTimeframe = "daily" | "weekly";

export interface Zone {
  kind:    ZoneKind;
  low:     number;      // structural lower bound
  high:    number;      // structural upper bound
  bandLow: number;      // ATR-padded entry band (low − bandHalf)
  bandHigh: number;     // high + bandHalf
  touches: number;      // count AFTER formation
  strength: number;     // touch + volume + TF weight
  source:  ZoneSource;
  tf:      ZoneTimeframe;
  formedAt: number;     // bar index of formation
  volumeAtFormation: number;
}

export interface DetectZonesOpts {
  tf?:    ZoneTimeframe;          // default "daily"
  trend?: "up" | "down";          // picks demand (up) vs supply (down). default "up"
  minTouches?: number;            // override the validity floor (default MIN_TOUCHES=2). UI adapter passes 0.
}

export interface ZoneGateResult {
  inZone:  boolean;
  zone:    Zone | null;
  distPct: number | null;
  reason:  string;
}

// ── FROZEN Phase-2 retest contracts (types only; not implemented in Phase 1) ─────
export interface ZoneRetestContext {
  zone:          Zone;
  direction:     "long" | "short";
  priceAtSignal: number;
  isFirstRetest: boolean;
}
export interface RetestContract {
  side: "long" | "short";
  level: number;
  atr14: number;
  bandLow: number;
  bandHigh: number;
  inBand: boolean;
  heldCloses: number;
  confirmCandles: number;
  paBonus: boolean;
  fomoRejected: boolean;
  limitPrice: number;
  valid: boolean;
}

// ── Measurement snapshot persisted per entry (architecture §6.2) ─────────────────
export interface EntryStructMeta {
  route: string;
  gatesActive: { zones: boolean; weeklyAnchor: boolean };
  zone: null | { kind: ZoneKind; low: number; high: number; touches: number; strength: number; source: ZoneSource };
  weekly: null | { direction: string; structure: string; slopePct: number; lastSwingLow: number | null; lastSwingHigh: number | null };
  priceAtEntry: number;
  distToZonePct: number | null;
}

// ─── Constants (verbatim from ruleset §2.4; RECOMMENDED_DEFAULT where ⚠️) ─────────
const ZONE_LOOKBACK_DAYS      = 126;
const ZONE_LOOKBACK_WEEKS     = 52;
const CONSOLIDATION_HALF_WIN  = 5;     // ±5 bars (matches legacy calcZones windowSize)
const ZONE_MAX_RANGE_PCT      = 4.0;
const ZONE_IMPULSE_MIN_PCT    = 3.0;
const MIN_TOUCHES             = 2;
const TOUCH_TOLERANCE_PCT     = 2.0;
const ZONE_MERGE_DISTANCE_PCT = 1.0;
const MAX_ZONES_PER_SIDE      = 3;
const MAX_TOUCH_BOOST         = 5;
const STRENGTH_TOUCH_WEIGHT   = 1.0;
const STRENGTH_VOLUME_WEIGHT  = 0.5;
const RETEST_BAND_MIN_PCT     = 0.5;
const RETEST_BAND_MAX_PCT     = 3.0;

/** ATR14 on the supplied bars (daily TF in Phase 1). Pure. */
export function ATR14(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

function countTouches(data: Bar[], low: number, high: number, formedAt: number): number {
  const tol = TOUCH_TOLERANCE_PCT / 100;
  let t = 0;
  for (let k = formedAt + 1; k < data.length; k++) {
    if (data[k].low <= high * (1 + tol) && data[k].high >= low * (1 - tol)) t++;
  }
  return t;
}

/** Shared band half-width: 0.5×ATR, floored at 0.5% and capped at 3% of the center. */
function clampHalf(center: number, atr: number): number {
  const minHalf = (RETEST_BAND_MIN_PCT / 100) * center;
  const maxHalf = (RETEST_BAND_MAX_PCT / 100) * center;
  return Math.min(Math.max(0.5 * atr, minHalf), maxHalf);
}
function bandHalf(low: number, high: number, atr: number): number {
  return clampHalf((low + high) / 2, atr);
}

/**
 * Ziv Phase 2 — the retest entry band around a single structural level. Shares the
 * zone band's clamp (0.5×ATR floored 0.5% / capped 3% of level) so the retest gate
 * band is provably identical to the zone band. Pure.
 */
export function retestBand(level: number, atr: number): { bandLow: number; bandHigh: number; halfPct: number } {
  const half = clampHalf(level, atr);
  return { bandLow: level - half, bandHigh: level + half, halfPct: level > 0 ? (half / level) * 100 : 0 };
}

function makeZone(
  kind: ZoneKind, low: number, high: number, formedAt: number,
  volumeAtFormation: number, source: ZoneSource, tf: ZoneTimeframe,
  atr: number, avgVol: number, data: Bar[],
): Zone {
  const touches = countTouches(data, low, high, formedAt);
  const half = bandHalf(low, high, atr);
  const strength =
    Math.min(touches, MAX_TOUCH_BOOST) * STRENGTH_TOUCH_WEIGHT +
    (avgVol > 0 ? (volumeAtFormation / avgVol) * STRENGTH_VOLUME_WEIGHT : 0) +
    (tf === "weekly" ? 2.0 : 1.0);
  return { kind, low, high, bandLow: low - half, bandHigh: high + half, touches, strength, source, tf, formedAt, volumeAtFormation };
}

/** Merge zones whose midpoints sit within ZONE_MERGE_DISTANCE_PCT; union boundaries. */
function mergeZones(zones: Zone[]): Zone[] {
  const sorted = [...zones].sort((a, b) => (a.low + a.high) - (b.low + b.high));
  const out: Zone[] = [];
  for (const z of sorted) {
    const last = out[out.length - 1];
    const lastMid = last ? (last.low + last.high) / 2 : 0;
    const zMid = (z.low + z.high) / 2;
    if (last && lastMid > 0 && Math.abs(zMid - lastMid) / lastMid <= ZONE_MERGE_DISTANCE_PCT / 100) {
      last.low = Math.min(last.low, z.low);
      last.high = Math.max(last.high, z.high);
      last.bandLow = Math.min(last.bandLow, z.bandLow);
      last.bandHigh = Math.max(last.bandHigh, z.bandHigh);
      last.touches = Math.max(last.touches, z.touches);
      last.strength = Math.max(last.strength, z.strength);
      last.source = "merged";
    } else {
      out.push({ ...z });
    }
  }
  return out;
}

/** Pure. Deterministic. Bars in → zones out. Demand zones for trend "up", supply for "down". */
export function detectZones(bars: Bar[], opts: DetectZonesOpts = {}): Zone[] {
  const trend = opts.trend ?? "up";
  const kind: ZoneKind = trend === "down" ? "supply" : "demand";
  const tf = opts.tf ?? "daily";
  const lookback = tf === "weekly" ? ZONE_LOOKBACK_WEEKS : ZONE_LOOKBACK_DAYS;
  const data = bars.slice(-lookback);
  const W = CONSOLIDATION_HALF_WIN;
  if (data.length < 2 * W + 2) return [];

  const atr = ATR14(data);
  const lastPrice = data[data.length - 1].close;
  const avgVol = data.reduce((s, b) => s + (b.volume ?? 0), 0) / data.length || 1;

  const raw: Zone[] = [];
  for (let i = W; i < data.length - W; i++) {
    const win = data.slice(i - W, i + W + 1);
    const rangeHigh = Math.max(...win.map(b => b.high));
    const rangeLow = Math.min(...win.map(b => b.low));
    if (rangeLow <= 0) continue;
    if ((rangeHigh - rangeLow) / rangeLow >= ZONE_MAX_RANGE_PCT / 100) continue;
    const after = data.slice(i + W, i + W + 10);
    if (after.length === 0) continue;
    const afterHigh = Math.max(...after.map(b => b.high));
    const afterLow = Math.min(...after.map(b => b.low));
    const isDemand = kind === "demand" && afterHigh > rangeHigh * (1 + ZONE_IMPULSE_MIN_PCT / 100);
    const isSupply = kind === "supply" && afterLow < rangeLow * (1 - ZONE_IMPULSE_MIN_PCT / 100);
    if (!isDemand && !isSupply) continue;
    const volAtFormation = win.reduce((s, b) => s + (b.volume ?? 0), 0) / win.length;
    raw.push(makeZone(kind, rangeLow, rangeHigh, i, volAtFormation, "consolidation", tf, atr, avgVol, data));
  }

  const minTouches = opts.minTouches ?? MIN_TOUCHES;
  return mergeZones(raw)
    .filter(z => z.touches >= minTouches)
    .sort((a, b) => {
      const da = Math.abs((a.low + a.high) / 2 - lastPrice);
      const db = Math.abs((b.low + b.high) / 2 - lastPrice);
      if (da !== db) return da - db;
      return b.strength - a.strength;
    })
    .slice(0, MAX_ZONES_PER_SIDE);
}

/** SSOT for "is this entry at a zone?" — symmetric. long→demand, short→supply. */
export function evaluateZoneGate(zones: Zone[], price: number, direction: "long" | "short"): ZoneGateResult {
  const wantKind: ZoneKind = direction === "long" ? "demand" : "supply";
  const candidates = zones.filter(z => z.kind === wantKind);
  if (candidates.length === 0) return { inZone: false, zone: null, distPct: null, reason: `no ${wantKind} zone` };

  // nearest by distance to mid, tie-break by strength
  const ranked = [...candidates].sort((a, b) => {
    const da = Math.abs((a.low + a.high) / 2 - price);
    const db = Math.abs((b.low + b.high) / 2 - price);
    if (da !== db) return da - db;
    return b.strength - a.strength;
  });
  const z = ranked[0];
  const mid = (z.low + z.high) / 2;
  const distPct = mid > 0 ? ((price - mid) / mid) * 100 : null;
  const inZone = price >= z.bandLow && price <= z.bandHigh;
  return {
    inZone, zone: z, distPct,
    reason: inZone ? `in ${wantKind} zone [${z.low.toFixed(2)}, ${z.high.toFixed(2)}]` : `price ${price.toFixed(2)} outside ${wantKind} band`,
  };
}

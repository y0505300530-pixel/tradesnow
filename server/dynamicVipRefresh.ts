/**
 * Dynamic VIP — daily refresh + persistence + read (Phase 1 server foundation).
 *
 * `computeVipSnapshot()` gathers live data (catalog, EMAs, kineticScore, finalScore, sector heat)
 * and ranks every ticker into VIP-A / VIP-B / BENCH via the pure `dynamicVip.ts` SSOT. It is the
 * SLOW path (fetches bars per ticker) — run by the daily 17:00 IL cron / the CLI, NOT per request.
 * `getVipTierMap()` is the FAST read: it parses the persisted `systemSettings.dynamic_vip` and
 * applies the owner override layer (pins → VIP-A, demotes → BENCH). Snooze stays a separate gate.
 *
 * Persistence is a single systemSettings row — it NEVER touches the trading engine. The engine
 * only consumes tiers when `dynamicVipEnabled=1` (a separate, later, QA-gated round).
 * Spec: docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md (+ handoff v2, daily)
 */
import { getDb, getSystemSetting, setSystemSetting } from "./db";
import { userAssets } from "../drizzle/schema";
import { isNotNull } from "drizzle-orm";
import { fetchBarsForTicker } from "./marketData";
import { calcEMA } from "./zivEngine";
import { scoreVipRank, applyTierCaps, type VipTier, type VipRankInput } from "./dynamicVip";

export const DYNAMIC_VIP_KEY = "dynamic_vip";
export const DYNAMIC_VIP_PREV_KEY = "dynamic_vip_prev";
export const DYNAMIC_VIP_PINS_KEY = "dynamic_vip_pins";
export const DYNAMIC_VIP_DEMOTES_KEY = "dynamic_vip_demotes";

export interface VipSnapshot {
  dayId: string;                 // YYYY-MM-DD (Israel)
  refreshedAt: number;           // epoch ms
  tiers: Record<VipTier, string[]>;
  reasons: Record<string, string[]>;
}

/** Israel-time YYYY-MM-DD. */
export function israelDayId(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

async function readJsonArray(key: string): Promise<string[]> {
  try { const v = await getSystemSetting(key); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a.map((x) => String(x).toUpperCase()) : []; }
  catch { return []; }
}

/**
 * SLOW: compute the full daily VIP snapshot from live data. `nowMs` is injected (Date.now is
 * banned in some contexts + keeps it testable). When `persist`, writes `dynamic_vip` (and rotates
 * the previous into `dynamic_vip_prev`). Returns the snapshot either way (dry-run = persist:false).
 */
export async function computeVipSnapshot(nowMs: number, opts?: { persist?: boolean }): Promise<VipSnapshot> {
  const db = await getDb();
  if (!db) throw new Error("no db");
  const raw = await db.select({
    ticker: userAssets.ticker, sector: userAssets.sector,
    kineticScore: userAssets.kineticScore, archived: userAssets.archived, catalogStatus: userAssets.catalogStatus,
  }).from(userAssets).where(isNotNull(userAssets.kineticScore));
  const rows: any[] = raw.filter((r: any) => !r.archived && r.catalogStatus !== "IPO_INCUBATOR");

  // finalScore from war_upcoming_signals.items[].combined (the engine's finalScore alias).
  const finalScoreByTicker = new Map<string, number>();
  try {
    const raw = await getSystemSetting("war_upcoming_signals");
    const parsed = raw ? JSON.parse(raw) : null;
    const items: any[] = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
    for (const s of items) {
      const t = String(s.ticker ?? "").toUpperCase();
      const fs = Number(s.combined ?? s.finalScore ?? s.score ?? s.ziv);
      if (t && Number.isFinite(fs)) finalScoreByTicker.set(t, fs);
    }
  } catch { /* optional */ }

  // sector heat: top-3 by avg kineticScore.
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) { const s = r.sector || "?"; const a = agg.get(s) ?? { sum: 0, n: 0 }; a.sum += Number(r.kineticScore) || 0; a.n++; agg.set(s, a); }
  const hot = new Set([...agg.entries()].map(([s, a]) => [s, a.sum / a.n] as const).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s]) => s));

  const ranked: Array<{ ticker: string; points: number; tier: VipTier; kineticScore: number }> = [];
  const reasons: Record<string, string[]> = {};
  for (const r of rows) {
    const ticker = String(r.ticker).toUpperCase();
    let e50 = false, e200 = false, slope = false;
    try {
      const bars = await fetchBarsForTicker(ticker, 420);
      const closes = bars.map((b: any) => b.close).filter((c: number) => c > 0);
      if (closes.length >= 50) {
        const last = closes[closes.length - 1];
        const ema50 = calcEMA(closes, 50);
        const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);
        e50 = last > ema50; e200 = last > ema200;
        slope = ema50 > (closes.length >= 55 ? calcEMA(closes.slice(0, -5), 50) : ema50);
      }
    } catch { /* no bars → below EMA → BENCH */ }
    const input: VipRankInput = {
      closeAboveEma50: e50, closeAboveEma200: e200, weeklyEma50SlopePos: slope,
      kineticScore: Number(r.kineticScore) || null,
      finalScore: finalScoreByTicker.get(ticker) ?? null,
      sectorHot: hot.has(r.sector || "?"),
    };
    const res = scoreVipRank(input);
    ranked.push({ ticker, points: res.points, tier: res.tier, kineticScore: Number(r.kineticScore) || 0 });
    reasons[ticker] = res.reasons;
  }
  const capped = applyTierCaps(ranked);
  const tiers: Record<VipTier, string[]> = { "VIP-A": [], "VIP-B": [], BENCH: [] };
  for (const [t, tier] of capped) tiers[tier].push(t);

  const snapshot: VipSnapshot = { dayId: israelDayId(nowMs), refreshedAt: nowMs, tiers, reasons };
  if (opts?.persist) {
    const prev = await getSystemSetting(DYNAMIC_VIP_KEY);
    if (prev) await setSystemSetting(DYNAMIC_VIP_PREV_KEY, prev);
    await setSystemSetting(DYNAMIC_VIP_KEY, JSON.stringify(snapshot));
  }
  return snapshot;
}

/** FAST: read the persisted snapshot (no compute). Returns null if never refreshed. */
export async function getDynamicVipSnapshot(): Promise<VipSnapshot | null> {
  try { const v = await getSystemSetting(DYNAMIC_VIP_KEY); return v ? (JSON.parse(v) as VipSnapshot) : null; }
  catch { return null; }
}

/**
 * FAST: ticker → final tier, applying the owner override layer on top of the snapshot:
 *   pins → VIP-A, demotes → BENCH. (Snooze stays a separate scan gate, not a tier.)
 * Returns an empty Map when no snapshot exists — callers fail open (no tier shown).
 */
export async function getVipTierMap(): Promise<Map<string, VipTier>> {
  const snap = await getDynamicVipSnapshot();
  const out = new Map<string, VipTier>();
  if (!snap) return out;
  (["VIP-A", "VIP-B", "BENCH"] as VipTier[]).forEach((tier) => snap.tiers[tier]?.forEach((t) => out.set(String(t).toUpperCase(), tier)));
  const [pins, demotes] = await Promise.all([readJsonArray(DYNAMIC_VIP_PINS_KEY), readJsonArray(DYNAMIC_VIP_DEMOTES_KEY)]);
  for (const t of pins) out.set(t, "VIP-A");
  for (const t of demotes) out.set(t, "BENCH");
  return out;
}

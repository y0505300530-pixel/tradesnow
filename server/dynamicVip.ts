/**
 * Dynamic VIP — weekly priority tiering (VIP-A / VIP-B / BENCH). PURE SSOT logic.
 *
 * INERT unless `dynamicVipEnabled=1`. These functions are pure + side-effect-free; the weekly
 * refresh job gathers the data (EMAs, kineticScore, finalScore, sector heat) and calls them,
 * and the engine/UI consume the resulting tiers. Golden rule: **rank ≠ gate bypass** — a tier
 * never flips ENTER→SKIP; it only orders who gets the last slot in a near-tie.
 *
 * Spec: docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md
 */

export type VipTier = "VIP-A" | "VIP-B" | "BENCH";

export const VIP_A_MAX = 12;
export const VIP_B_MAX = 20;
/** Tier breaks an ENTER-loop tie ONLY when the finalScore gap is within this band. */
export const TIER_TIEBREAK_THRESHOLD = 0.5;
export const TIER_RANK: Record<VipTier, number> = { "VIP-A": 3, "VIP-B": 2, BENCH: 1 };

export interface VipRankInput {
  closeAboveEma50: boolean;      // structural +1
  closeAboveEma200: boolean;     // structural +1
  weeklyEma50SlopePos: boolean;  // structural +1
  kineticScore: number | null;   // momentum +1 when >= 70
  finalScore: number | null;     // momentum +1 when >= 7.5 (from war_upcoming_signals)
  sectorHot: boolean;            // sector bonus +1 (top-3 sector by avg kineticScore)
}

export interface VipRankResult { points: number; tier: VipTier; reasons: string[]; }

/**
 * Raw tier from the weekly ranking algorithm (before the VIP-A≤12 / VIP-B≤20 population caps,
 * which `applyTierCaps` enforces). `close < EMA50` ("falling knife") forces BENCH regardless of
 * any other points — this is what auto-benches MTSI/RIOT without a manual snooze.
 */
export function scoreVipRank(input: VipRankInput): VipRankResult {
  const reasons: string[] = [];
  let structural = 0, momentum = 0, sector = 0;
  if (input.closeAboveEma50) structural++; else reasons.push("below_ema50");
  if (input.closeAboveEma200) structural++;
  if (input.weeklyEma50SlopePos) structural++;
  if ((input.kineticScore ?? 0) >= 70) { momentum++; reasons.push("kinetic>=70"); }
  if ((input.finalScore ?? 0) >= 7.5) { momentum++; reasons.push("finalScore>=7.5"); }
  if (input.sectorHot) { sector++; reasons.push("sector_hot"); }
  const points = structural + momentum + sector;

  let tier: VipTier;
  if (!input.closeAboveEma50) tier = "BENCH";       // falling knife — hard BENCH
  else if (points >= 5) tier = "VIP-A";
  else if (points >= 3) tier = "VIP-B";
  else tier = "BENCH";
  return { points, tier, reasons };
}

/**
 * Enforce the population caps after ranking: sort by points desc, keep the top VIP_A_MAX as
 * VIP-A, the next VIP_B_MAX as VIP-B, and demote the overflow to BENCH. Owner pins/demotes are
 * applied by the caller BEFORE this. Returns ticker → final tier.
 */
export function applyTierCaps(
  ranked: Array<{ ticker: string; points: number; tier: VipTier }>,
): Map<string, VipTier> {
  const out = new Map<string, VipTier>();
  const byPoints = [...ranked].sort((a, b) => b.points - a.points);
  let aCount = 0, bCount = 0;
  for (const r of byPoints) {
    if (r.tier === "VIP-A" && aCount < VIP_A_MAX) { out.set(r.ticker, "VIP-A"); aCount++; }
    else if ((r.tier === "VIP-A" || r.tier === "VIP-B") && bCount < VIP_B_MAX) { out.set(r.ticker, "VIP-B"); bCount++; }
    else out.set(r.ticker, "BENCH");
  }
  return out;
}

/** Display-only sort boost by tier (effectiveSortScore / Armed top-N). NEVER a gate. */
export function tierSortBoost(tier: VipTier): number {
  return tier === "VIP-A" ? 0.6 : tier === "VIP-B" ? 0.2 : 0;
}

/**
 * ENTER-loop comparator (owner-ratified two-stage). Primary = finalScore (edge). Tier breaks the
 * tie ONLY when the finalScore gap is ≤ TIER_TIEBREAK_THRESHOLD; otherwise the higher finalScore
 * wins outright (INV-2). Returns <0 if `a` should enter before `b` (Array.sort ascending → a first).
 */
export function compareEnterPriority(
  a: { finalScore: number; kineticScore: number; tier: VipTier },
  b: { finalScore: number; kineticScore: number; tier: VipTier },
): number {
  const gap = (b.finalScore ?? 0) - (a.finalScore ?? 0);
  if (Math.abs(gap) > TIER_TIEBREAK_THRESHOLD) return gap; // edge wins outright — rank never bypasses it
  const dTier = TIER_RANK[b.tier] - TIER_RANK[a.tier];     // near-tie → tier decides
  if (dTier !== 0) return dTier;
  if (gap !== 0) return gap;
  return (b.kineticScore ?? 0) - (a.kineticScore ?? 0);
}

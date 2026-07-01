/**
 * mentorScoreBoost.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads learned mentor patterns (from mentorPatterns table) and returns a
 * score bonus for tickers / signal types that match known patterns.
 *
 * Max total boost: +2.0 points.
 * Called inside warEngine.ts before entry decisions.
 */

import { getDb } from "./db";
import { mentorPatterns } from "../drizzle/schema";
import { eq } from "drizzle-orm";

export interface MentorBoostResult {
  bonus: number;           // 0.0 – 2.0 extra points
  reasons: string[];       // human-readable explanations
  isDualSignal: boolean;   // both Ziv AND Micha flagged this ticker
}

// How a ticker maps to a pattern:
// 1. ticker is in the pattern's tickers JSON array
// 2. the signal name contains a known pattern keyword
const SIGNAL_PATTERN_MAP: Record<string, string[]> = {
  "GOLD_BREAKOUT":           ["Donchian Breakout", "All Time High Break", "Breakout Consolidation"],
  "GOLD_RETEST":             ["Gold Retest", "Demand Zone Entry", "Bull Trend Pullback"],
  "BEAR_BREAKDOWN":          ["Bear Breakdown"],
  "BEAR_RETEST":             ["Bear Retest", "Demand Zone Entry"],
  "NEAR_ENTRY_WATCH":        ["Waiting for Pullback", "Cup & Handle"],
};

let _patternCache: Array<{
  id: number; mentor: string; patternName: string;
  occurrences: number; tickers: string | null;
}> | null = null;
let _patternCacheAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getPatterns(userId: number) {
  if (_patternCache && Date.now() - _patternCacheAt < CACHE_TTL) return _patternCache;
  const db = await getDb();
  if (!db) return [];
  const _rows = await db
    .select({ id: mentorPatterns.id, mentor: mentorPatterns.mentor,
              patternName: mentorPatterns.patternName, occurrences: mentorPatterns.occurrences,
              tickers: mentorPatterns.tickers })
    .from(mentorPatterns)
    .where(eq(mentorPatterns.userId, userId));
  // Pre-parse `tickers` ONCE per cache build (10-min TTL) instead of JSON.parse per pattern on
  // every calcMentorBoost call (called 2×/ticker × ~150 tickers × cycle). Byte-identical result.
  _patternCache = _rows.map(p => ({
    ...p,
    tickersUpper: (() => { try { return (JSON.parse(p.tickers ?? "[]") as string[]).map(t => t.toUpperCase()); } catch { return []; } })(),
  }));
  _patternCacheAt = Date.now();
  return _patternCache;
}

export async function calcMentorBoost(
  userId: number,
  ticker: string,
  signal: string,           // e.g. "GOLD_BREAKOUT", "BEAR_BREAKDOWN"
  mentorSources?: string,   // from userAssets.mentorSources (e.g. "Ziv+Micha")
  confidenceScore?: number, // Phase 1: mentor_confidence 1–5 from LLM analysis
): Promise<MentorBoostResult> {
  const patterns = await getPatterns(userId);
  const tickerUpper = ticker.toUpperCase();
  const reasons: string[] = [];
  let bonus = 0;

  // Map signal → expected patterns
  const expectedPatterns = Object.entries(SIGNAL_PATTERN_MAP)
    .filter(([sig]) => signal.toUpperCase().includes(sig))
    .flatMap(([, pats]) => pats);

  for (const p of patterns) {
    if (p.occurrences < 2) continue; // need at least 2 sightings

    const tickerMatch = ((p as any).tickersUpper ?? []).includes(tickerUpper);
    const patternMatch = expectedPatterns.includes(p.patternName);

    if (!tickerMatch && !patternMatch) continue;

    // Calculate bonus per pattern
    const occurrenceBonus = Math.min(0.5, p.occurrences * 0.1); // up to +0.5 per pattern
    const mentorMultiplier = p.mentor === "both" ? 1.5 : 1.0;   // dual-mentor patterns worth more
    const patternBonus = occurrenceBonus * mentorMultiplier;

    bonus += patternBonus;
    const mentorLabel = p.mentor === "both" ? "Ziv+Micha" : p.mentor === "micha_stocks" ? "Micha" : "Ziv";
    reasons.push(`${p.patternName} [${mentorLabel} ×${p.occurrences}] +${patternBonus.toFixed(2)}`);
  }

  // Dual signal from mentorSources field (userAssets)
  const isDualSignal = !!(mentorSources && mentorSources.includes("+"));
  if (isDualSignal) {
    bonus += 0.5;
    reasons.push("Dual Signal (Ziv+Micha) +0.50");
  }

  // ── Phase 1: Confidence Score Multiplier ──────────────────────────────
  // mentor_confidence (1–5) scales the raw bonus:
  //   5 → ×1.20 (+20% boost — active trade, full conviction)
  //   4 → ×1.10 (+10% boost — imminent entry)
  //   3 → ×1.00 (neutral — no change, standard watch)
  //   2 → ×0.70 (−30% penalty — informational mention)
  //   1 → ×0.00 (zero bonus — REJECTED signal / speculative mention)
  if (confidenceScore !== undefined && confidenceScore >= 1 && confidenceScore <= 5) {
    const confMultipliers: Record<number, number> = { 1: 0.0, 2: 0.7, 3: 1.0, 4: 1.1, 5: 1.2 };
    const mult = confMultipliers[Math.round(confidenceScore)] ?? 1.0;
    if (mult !== 1.0) {
      const oldBonus = bonus;
      bonus = bonus * mult;
      reasons.push(`Confidence ×${mult.toFixed(1)} (score=${Math.round(confidenceScore)}/5) → ${oldBonus.toFixed(2)}→${bonus.toFixed(2)}`);
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  return { bonus: Math.min(2.0, bonus), reasons, isDualSignal };
}

/** Invalidate pattern cache (called after autoSyncAndAnalyze updates patterns) */
export function invalidateMentorPatternCache() {
  _patternCache = null;
}

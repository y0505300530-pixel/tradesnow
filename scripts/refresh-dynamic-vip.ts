/**
 * Dynamic VIP — DAILY dry-run (Phase 0). Reads the live catalog, computes VIP-A/B/BENCH tiers via
 * the pure server/dynamicVip.ts SSOT, and LOGS what it would do. Writes NOTHING — pure observation
 * (DV-G1). INERT: never touches the engine, orders, or the dynamicVipEnabled flag.
 *   Run (dry-run): node --env-file=.env --import tsx scripts/refresh-dynamic-vip.ts
 * Spec: docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md (+ handoff v2, daily 17:00 IL)
 */
import mysql from "mysql2/promise";
import { fetchBarsForTicker } from "../server/marketData";
import { calcEMA } from "../server/zivEngine";
import { scoreVipRank, applyTierCaps, type VipTier, type VipRankInput } from "../server/dynamicVip";

async function main() {
  const db = await mysql.createConnection(process.env.DATABASE_URL!);

  // 1. Universe: active USA catalog, has kineticScore, not IPO incubator.
  const [rows] = await db.query(
    "select ticker, sector, kineticScore from userAssets " +
    "where archived=0 and kineticScore is not null and (catalogStatus is null or catalogStatus <> 'IPO_INCUBATOR')",
  ) as any;
  console.log(`[VIP-DRYRUN] universe: ${rows.length} tickers`);

  // 2. finalScore lookup from war_upcoming_signals (best-effort, optional).
  const finalScoreByTicker = new Map<string, number>();
  try {
    const [ws] = await db.query("select value from systemSettings where `key`='war_upcoming_signals'") as any;
    if (ws[0]) {
      const parsed = JSON.parse(ws[0].value);
      const arr: any[] = Array.isArray(parsed) ? parsed : (parsed.signals ?? parsed.candidates ?? parsed.upcoming ?? []);
      for (const s of arr) {
        const t = String(s.ticker ?? "").toUpperCase();
        const fs = Number(s.finalScore ?? s.zivScore ?? s.score);
        if (t && Number.isFinite(fs)) finalScoreByTicker.set(t, fs);
      }
    }
  } catch { /* finalScore is optional */ }
  console.log(`[VIP-DRYRUN] finalScore available for ${finalScoreByTicker.size} tickers`);

  // 3. sector heat: top-3 sectors by avg kineticScore.
  const sectorAgg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const sec = r.sector || "?";
    const a = sectorAgg.get(sec) ?? { sum: 0, n: 0 };
    a.sum += Number(r.kineticScore) || 0; a.n++; sectorAgg.set(sec, a);
  }
  const hotSectors = new Set(
    [...sectorAgg.entries()].map(([s, a]) => [s, a.sum / a.n] as const)
      .sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s]) => s));
  console.log(`[VIP-DRYRUN] hot sectors (top-3 by avg kinetic): ${[...hotSectors].join(", ")}`);

  // 4. per-ticker structural (EMA) + momentum → raw rank.
  const ranked: Array<{ ticker: string; points: number; tier: VipTier; kineticScore: number }> = [];
  const reasonsByTicker = new Map<string, string[]>();
  let barsFail = 0;
  for (const r of rows) {
    const ticker = String(r.ticker).toUpperCase();
    let closeAboveEma50 = false, closeAboveEma200 = false, weeklyEma50SlopePos = false;
    try {
      const bars = await fetchBarsForTicker(ticker, 420);
      const closes = bars.map((b: any) => b.close).filter((c: number) => c > 0);
      if (closes.length >= 50) {
        const last = closes[closes.length - 1];
        const ema50 = calcEMA(closes, 50);
        const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);
        closeAboveEma50 = last > ema50;
        closeAboveEma200 = last > ema200;
        // weekly EMA50 slope proxy: EMA50 now vs EMA50 five sessions ago (~1 week).
        const ema50Prev = closes.length >= 55 ? calcEMA(closes.slice(0, -5), 50) : ema50;
        weeklyEma50SlopePos = ema50 > ema50Prev;
      } else { barsFail++; }
    } catch { barsFail++; /* no bars → below EMA → BENCH */ }
    const input: VipRankInput = {
      closeAboveEma50, closeAboveEma200, weeklyEma50SlopePos,
      kineticScore: Number(r.kineticScore) || null,
      finalScore: finalScoreByTicker.get(ticker) ?? null,
      sectorHot: hotSectors.has(r.sector || "?"),
    };
    const res = scoreVipRank(input);
    ranked.push({ ticker, points: res.points, tier: res.tier, kineticScore: Number(r.kineticScore) || 0 });
    reasonsByTicker.set(ticker, res.reasons);
  }
  if (barsFail) console.log(`[VIP-DRYRUN] ${barsFail} tickers had <50 bars → treated as below-EMA (BENCH)`);

  // 5. apply population caps → final tiers.
  const finalTiers = applyTierCaps(ranked);
  const group = (t: VipTier) => [...finalTiers.entries()].filter(([, v]) => v === t).map(([k]) => k);
  const vipA = group("VIP-A"), vipB = group("VIP-B"), bench = group("BENCH");

  console.log(`\n[VIP-DRYRUN] ⭐⭐ VIP-A (${vipA.length}): ${vipA.join(", ")}`);
  console.log(`[VIP-DRYRUN] ⭐ VIP-B (${vipB.length}): ${vipB.join(", ")}`);
  console.log(`[VIP-DRYRUN] 🪑 BENCH (${bench.length}): ${bench.slice(0, 40).join(", ")}${bench.length > 40 ? " …" : ""}`);

  // 6. DV-G1 sanity: MTSI / RIOT must land BENCH.
  for (const t of ["MTSI", "RIOT"]) {
    const tier = finalTiers.get(t);
    const mark = tier === "BENCH" ? "✅" : tier ? "⚠️ expected BENCH" : "(not in universe)";
    console.log(`[VIP-DRYRUN] DV-G1 ${t} → ${tier ?? "-"} ${mark}  reasons=[${(reasonsByTicker.get(t) ?? []).join(",")}]`);
  }
  console.log("[VIP-DRYRUN] DRY-RUN complete — wrote NOTHING. dynamicVipEnabled unchanged, engine untouched.");
  await db.end();
  process.exit(0);
}
main().catch((e) => { console.error("[VIP-DRYRUN] error:", e); process.exit(1); });

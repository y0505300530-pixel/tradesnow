/**
 * liveEngine.ts — tRPC router for Elza Live Engine
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure } from "../_core/trpc";
import { executeLivePartialClose, realDeps as partialDeps } from "../executePartial";
import {
  getLiveConfig, updateLiveConfig, computeLiveCapital,
  tryLiveEntry, executeLiveSell, finalizePendingExit, emergencyExitAll, runLiveSlMonitor, isLiveMarketOpen,
  runDeleveragingCycle, fetchLiveNlvAndDayPnl
} from "../liveOrderExecutor";
import { getDb } from "../db";
import { livePositions, systemLogs, liveTrades, liveEngineConfig, systemSettings, portfolioHoldings } from "../../drizzle/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { ibindRequest, primeAccountsIfNeeded } from "../routers/ibkrProxy";
import { ibindCached, invalidateIbkrCache } from "../ibkrCache";
import { log } from "../logger";
import { LIVE_ACCOUNT_ID } from "../liveOrderExecutor";
import { calcEntrySlTp, ema50FromBars } from "../slCalculator";
import { fetchBarsForTicker, fetchLivePrice } from "../marketData";
import { claimManualOrder, settleManualOrder, releaseManualOrder, type ManualOrderResult } from "../manualOrderIdempotency";
import {
  issueActionConfirmToken,
  consumeActionConfirmToken,
  LIVE_DESTRUCTIVE_ACTIONS,
} from "../utils/actionConfirmToken";
import {
  toLedgerRow,
  computeStats,
  groupBy,
  PHANTOM_REASONS,
  NO_PRICE_REASONS,
  type LedgerRow,
} from "../tradeLedger";
import {
  startProgress,
  setProgress,
  finishProgress,
  getProgress,
  getSummary,
  WR_PHASE,
} from "../warRoomProgress";

const destructiveActionSchema = z.enum(LIVE_DESTRUCTIVE_ACTIONS);

// ── Non-re-entrant latch for the manual EOD-Trim mutation ────────────────────
// Mirrors the cron's _cbTickRunning pattern: a second concurrent click while a
// trim sweep is mid-flight (slow IBKR fills/reads) must NOT fire a second wave of
// sell orders. The sweep itself is idempotent (broker-truth: already-flat positions
// are skipped), but the latch keeps two sweeps from racing the same positions.
let _manualTrimRunning = false;

function requireConfirmToken(
  userId: number,
  action: (typeof LIVE_DESTRUCTIVE_ACTIONS)[number],
  confirmToken: string | undefined,
): void {
  if (!confirmToken || !consumeActionConfirmToken(userId, action, confirmToken)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "CONFIRM_TOKEN_INVALID",
    });
  }
}

const WAR_ROOM_IBKR_TTL_MS = 4_000;

function sumDailyPnlFromPositions(positions: any[]): number {
  return positions.reduce((s, p) => {
    if (typeof (p as any).dailyPnlUsd === "number") {
      return s + (p as any).dailyPnlUsd;
    }
    const mult = p.direction === "short" ? -1 : 1;
    const dailyChange = (p as any).dailyChange;
    const dailyPctPos = (p as any).dailyPctPosition;  // already direction-signed
    const dailyPctRaw = (p as any).dailyPct;          // unsigned → needs direction mult
    const units = p.units ?? 0;
    const value = Math.abs((p as any).marketValueSigned ?? p.value ?? p.allocatedCapital ?? 0);
    if (typeof dailyChange === "number" && units > 0) {
      return s + dailyChange * units * mult;
    }
    if (typeof dailyPctPos === "number" && value > 0) {
      return s + (dailyPctPos / 100) * value;        // signed — use as-is
    }
    if (typeof dailyPctRaw === "number" && value > 0) {
      return s + (dailyPctRaw / 100) * value * mult;  // unsigned — apply direction
    }
    return s;
  }, 0);
}


export const liveEngineRouter = {
  // ── Hold-to-confirm: issue one-time token after client UI gate ────────────
  requestActionToken: adminProcedure
    .input(z.object({ action: destructiveActionSchema }))
    .mutation(async ({ ctx, input }) => {
      return issueActionConfirmToken(ctx.user.id, input.action);
    }),

  // ── Refresh "Upcoming Candidates" — re-score the forecast on demand. ─────────
  // SCAN-ONLY: re-runs the WarEngine scan + persists STATUS/SIGNAL/SCORE, but
  // places NO live orders (the autonomous cycle still handles real entries). The
  // scanOnly:true path breaks out of the entry-execution loop BEFORE tryLiveEntry,
  // so this endpoint can NEVER place/cancel/modify a live order.
  refreshCandidates: adminProcedure.mutation(async ({ ctx }) => {
    const { runWarEngineCycle } = await import("../warEngine");
    startProgress(WR_PHASE.START);
    try {
      const r = await runWarEngineCycle(ctx.user.id, {
        manual: true,
        scanOnly: true,
        onProgress: (p) => setProgress(p),
      });
      const count = Array.isArray(r.topCandidates) ? r.topCandidates.length : 0;
      const scannedAt = new Date().toISOString();
      finishProgress({
        errors: [],
        successes: [`סריקה הושלמה — ${r.scanned} נסרקו, ${count} מועמדים`],
        actions: [],
      });
      return { ok: true, count, scannedAt };
    } catch (e: any) {
      finishProgress({ errors: [e?.message ?? "scan failed"], successes: [], actions: [] });
      throw e;
    }
  }),

  // ── Run a FULL War-Engine cycle MANUALLY — SCAN-ONLY (no live orders). ────────
  // Reuses the SAME hardened scanOnly path as refreshCandidates / insights.runWarEngine.
  // Returns "what WOULD happen": candidates found, gates that fired, would-enter list.
  // Real order placement stays exclusively in the autonomous armed cycle — this UI
  // endpoint can NEVER place/cancel/modify a live order.
  runManualCycle: adminProcedure.mutation(async ({ ctx }) => {
    const { runWarEngineCycle } = await import("../warEngine");
    startProgress(WR_PHASE.START);
    try {
      const r = await runWarEngineCycle(ctx.user.id, {
        manual: true,
        scanOnly: true,
        onProgress: (p) => setProgress(p),
      });

      const cands = Array.isArray(r.topCandidates) ? r.topCandidates : [];
      // What WOULD enter — the candidates the gates admitted (action === "ENTER").
      const wouldEnter = cands
        .filter((c: any) => c.action === "ENTER")
        .map((c: any) => ({
          ticker: String(c.ticker),
          route: c.direction === "short" ? "SHORT" : "LONG",
          score: +Number(c.finalScore ?? 0).toFixed(2),
        }));
      // Gates that fired — every non-ENTER candidate with the gate label + reason.
      const gatesFired = cands
        .filter((c: any) => c.action !== "ENTER")
        .map((c: any) => ({
          ticker: String(c.ticker),
          gate: c.action === "BLOCKED" ? "BLOCKED" : "SKIP",
          reason: String(c.blockReason ?? "—"),
        }));
      const actions: string[] = [
        `נסרקו ${r.scanned} מניות`,
        `נוהלו ${r.managed} פוזיציות (סטופים/יציאות)`,
        `${wouldEnter.length} מועמדים עברו את כל החומות (סריקה בלבד — לא בוצעו פקודות)`,
        `מצב שוק: ${r.regimeDecision}`,
      ];
      const finishedAt = new Date().toISOString();
      finishProgress({ errors: [], successes: actions, actions });
      return {
        ok: true,
        finishedAt,
        summary: {
          candidatesFound: cands.length,
          gatesFired,
          errors: [] as string[],
          actions,
          wouldEnter,
        },
      };
    } catch (e: any) {
      finishProgress({ errors: [e?.message ?? "cycle failed"], successes: [], actions: [] });
      throw e;
    }
  }),

  // ── Live cycle progress (polled ~1s by the War Room during a Run). FAST. ──────
  // Reads the in-memory module store — no DB, no IBKR. running=false + pct=100 at end.
  getCycleProgress: adminProcedure.query(() => {
    return getProgress();
  }),

  // ── Last cycle summary (side panel). FAST — in-memory snapshot of the last run. ──
  getCycleSummary: adminProcedure.query(() => {
    const s = getSummary();
    return {
      errors: s.errors,
      successes: s.successes,
      actions: s.actions,
      finishedAt: s.finishedAt,
    };
  }),

  // ── Deep Analysis v4.5 — the REAL deployed v4.5 decision for ONE ticker. ──────
  // SSOT: server/engine/elzaV45Master.ts (genesisScore/scoreLong/wideLungSL) + the
  // LIVE gates the armed cycle actually applies (Defense Mode SPY<EMA50, §2 VIX band,
  // score≥7.0 / confluence≥4.5 / liquidity≥2.0, EMA200, wide-lung SL<entry). READ-ONLY:
  // no DB writes, no IBKR orders. Mirrors the engine's real decision — no legacy/ZIV
  // fields that contradict it.
  deepAnalysisV45: adminProcedure
    .input(z.object({ ticker: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const ticker = input.ticker.toUpperCase().trim();
      const { genesisScore, scoreLong, wideLungSL, vixSizeBand, getRegime, ELZA_V45_CFG } =
        await import("../engine/elzaV45Master");
      const { getMarketRegime, getTickerIntelligence } = await import("../runtimeIntelligence");
      const { fetchBarsForTicker } = await import("../marketData");
      const { calcEMA } = await import("../zivEngine");

      const cfg = ELZA_V45_CFG;
      const rejectionReasons: string[] = [];
      const gatesFired: { gate: string; passed: boolean; reason: string }[] = [];

      // ── Macro (SPY daily close vs daily EMA-50 = Defense Mode) + VIX band ──────
      // Defense Mode uses the LITERAL daily SPY<EMA50 (same source as the live gate
      // in liveOrderExecutor.assertLongAllowedByRegime). The weekly getMarketRegime
      // supplies vixProxy + regime label for the VIX band + display.
      let spy = 0, spyEma50 = 0, regimeLabel = "UNKNOWN", vix = NaN, vixBand = "n/a", defensePass = false;
      try {
        const spyBars = await fetchBarsForTicker("SPY", 420);
        if (spyBars && spyBars.length >= 50) {
          const closes = spyBars.map((b: any) => b.close);
          spy = closes[closes.length - 1];
          spyEma50 = calcEMA(closes, 50);
          defensePass = Number.isFinite(spy) && Number.isFinite(spyEma50) && spy > 0 &&
            getRegime(spy, spyEma50) === "BULL";
        }
      } catch { /* spy read failed → defensePass stays false (fail-closed) */ }
      try {
        const mr = await getMarketRegime({});
        vix = mr.vixProxy;
        regimeLabel = mr.regime;
      } catch { /* leave vix NaN → VIX band will report block */ }
      const band = vixSizeBand(vix);
      vixBand = !Number.isFinite(vix)
        ? "BLOCK (VIX n/a)"
        : vix > cfg.VIX_BLOCK ? `BLOCK (VIX ${vix.toFixed(1)} > ${cfg.VIX_BLOCK})`
        : vix > cfg.VIX_REDUCE ? `HALF (VIX ${vix.toFixed(1)} > ${cfg.VIX_REDUCE})`
        : `FULL (VIX ${vix.toFixed(1)} ≤ ${cfg.VIX_REDUCE})`;

      // DEFENSE gate (SPY<EMA50) — the macro wall that blocks ALL new longs.
      gatesFired.push({
        gate: "DEFENSE (SPY<EMA50)",
        passed: defensePass,
        reason: defensePass
          ? `SPY $${spy.toFixed(2)} > daily EMA-50 $${spyEma50.toFixed(2)} — longs allowed`
          : `SPY $${spy.toFixed(2)} ≤ daily EMA-50 $${spyEma50.toFixed(2)} (or unreadable) — longs blocked`,
      });
      if (!defensePass) rejectionReasons.push("DEFENSE_MODE — SPY below daily EMA-50 (or SPY read failed)");

      // VIX band gate.
      gatesFired.push({
        gate: "VIX band (§2)",
        passed: !band.block,
        reason: vixBand,
      });
      if (band.block) rejectionReasons.push(`VIX guard — ${vixBand}`);

      // ── Per-ticker SSOT scoring ───────────────────────────────────────────────
      let base = 0, subTotal = 0, total = 0;
      let tier: string | null = null;
      let route: string | null = null;
      let ema200Pass = false, wideLungPass = false, scoreGatePass = false;
      let conf = 0, liq = 0;
      try {
        const bars = await fetchBarsForTicker(ticker, 420);
        if (!bars || bars.length < 200) {
          rejectionReasons.push(`insufficient history (${bars?.length ?? 0} bars < 200)`);
        } else {
          const i = bars.length - 1;
          const gs = genesisScore(bars, i);
          base = gs.baseScore;
          subTotal = gs.subScore;
          total = gs.totalScore;
          tier = gs.tier;
          ema200Pass = gs.price > gs.ema200 && gs.ema200 > 0;

          const intel = await getTickerIntelligence(ticker, bars as any);
          conf = intel.confluenceScore;
          liq = intel.liquidityScore;

          // The composite SSOT gate (totalScore≥7.0 AND confluence≥4.5 AND liquidity≥2.0).
          scoreGatePass =
            total >= cfg.LONG_MIN_SCORE && conf >= cfg.MIN_CONFLUENCE && liq >= cfg.MIN_LIQUIDITY;

          // wide-lung SL must sit below entry (defined risk) — same check scoreLong makes.
          if (gs.tier !== null) {
            try {
              const sl = wideLungSL(gs.price, gs.ema50, "long");
              wideLungPass = gs.price - sl > 0;
            } catch { wideLungPass = false; }
          }

          // Route falls out of the SSOT tier (mirrors warEngine's finalScore≥9 router).
          if (gs.tier === "Gold Breakout") route = "GOLD_BREAKOUT_WAR";
          else if (gs.tier === "Gold Retest") route = "GOLD_RETEST_WAR";
        }
      } catch (e: any) {
        rejectionReasons.push(`scoring threw: ${e?.message ?? e}`);
      }

      // EMA200 gate.
      gatesFired.push({
        gate: "EMA200 (price>EMA200)",
        passed: ema200Pass,
        reason: ema200Pass ? "price above EMA-200" : "price at/below EMA-200 (or no tier)",
      });
      if (!ema200Pass && tier !== null) rejectionReasons.push("price not above EMA-200");

      // Composite score/confluence/liquidity gate.
      gatesFired.push({
        gate: "score≥7.0 / conf≥4.5 / liq≥2.0",
        passed: scoreGatePass,
        reason: `total ${total.toFixed(2)} (≥${cfg.LONG_MIN_SCORE}) · conf ${conf.toFixed(1)} (≥${cfg.MIN_CONFLUENCE}) · liq ${liq.toFixed(1)} (≥${cfg.MIN_LIQUIDITY})`,
      });
      if (!scoreGatePass && tier !== null) {
        if (total < cfg.LONG_MIN_SCORE) rejectionReasons.push(`total ${total.toFixed(2)} < ${cfg.LONG_MIN_SCORE}`);
        if (conf < cfg.MIN_CONFLUENCE) rejectionReasons.push(`confluence ${conf.toFixed(1)} < ${cfg.MIN_CONFLUENCE}`);
        if (liq < cfg.MIN_LIQUIDITY) rejectionReasons.push(`liquidity ${liq.toFixed(1)} < ${cfg.MIN_LIQUIDITY}`);
      }
      if (tier === null) rejectionReasons.push("no qualifying setup (no Gold Retest/Breakout tier)");

      // wide-lung SL gate.
      gatesFired.push({
        gate: "wideLungSL (SL<entry)",
        passed: wideLungPass,
        reason: wideLungPass ? "wide-lung stop sits below entry (defined risk)" : "no valid stop below entry",
      });
      if (!wideLungPass && tier !== null) rejectionReasons.push("wide-lung SL not below entry");

      // FINAL: the candidate passes the live gate ONLY if EVERY wall passes. This is
      // the AND of the real deployed v4.5 ruleset (Defense + VIX + tier + EMA200 +
      // score/conf/liq + wide-lung). Mirrors scoreLong returning non-null AND the live
      // Defense/VIX guards admitting it.
      const passedGate =
        defensePass && !band.block && tier !== null && ema200Pass && scoreGatePass && wideLungPass;

      return {
        ticker,
        score: {
          base: +base.toFixed(2),
          subTotal: +subTotal.toFixed(2),
          total: +total.toFixed(2),
        },
        tier,
        route,
        passedGate,
        gatesFired,
        macro: {
          spy: +spy.toFixed(2),
          spyEma50: +spyEma50.toFixed(2),
          regime: regimeLabel,
          vix: Number.isFinite(vix) ? +vix.toFixed(2) : null,
          vixBand,
        },
        rejectionReasons,
      };
    }),

  // ── Pause/Resume buying (stop new entries without closing existing) ────────
  pauseBuying: adminProcedure
    .input(z.object({ paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(liveEngineConfig)
        .set({ isEnabled: input.paused ? 0 : 1 })
        .where(eq(liveEngineConfig.userId, ctx.user.id));
      return { ok: true, paused: input.paused };
    }),

  // ── Manual IBKR OCA sync (force-check fills) ─────────────────────────────
  syncNow: adminProcedure.mutation(async ({ ctx }) => {
    const { runIbkrPositionSync } = await import("../ibkrPositionSync");
    const result = await runIbkrPositionSync(ctx.user.id);
    return result;
  }),


  // ── Get config + status ──────────────────────────────────────────────────
  getStatus: adminProcedure
    .input(z.object({ bustCache: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
    if (input?.bustCache) {
      invalidateIbkrCache("/pnl");
      invalidateIbkrCache("/positions");
      invalidateIbkrCache("/account/summary");
      invalidateIbkrCache("/orders");
    }

    const config = await getLiveConfig(ctx.user.id);
    if (!config) return { config: null, positions: [], summary: null };

    const db = await getDb();
    if (!db) return { config, positions: [], summary: null };

    // ── PRIMARY: Load positions from IBKR live account (source of truth) ──
    let positions: any[] = [];
    try {
      const [posRes, ordersRes] = await Promise.all([
        ibindCached("GET", "/positions", undefined, WAR_ROOM_IBKR_TTL_MS),
        ibindCached("GET", "/orders", undefined, WAR_ROOM_IBKR_TTL_MS),
      ]);

      // Build SL/TP map from active orders
      const slMap = new Map<string, number>(); // ticker → SL price
      const tpMap = new Map<string, number>(); // ticker → TP price
      if (ordersRes.ok) {
        const allOrders: any[] = (ordersRes.body as any)?.orders ?? [];
        const active = allOrders.filter((o: any) =>
          ["PreSubmitted","Submitted","Working"].includes(o.status)
        );
        for (const o of active) {
          const ticker = (o.description1 ?? o.ticker ?? "").toUpperCase();
          if (!ticker) continue;
          const side = (o.side ?? "").toUpperCase();
          const type = (o.orderType ?? "").toLowerCase();
          const isSell = side.startsWith("S");
          if (!isSell) continue;
          if (type === "stop" || type === "stp") {
            const slPrice = parseFloat(o.auxPrice);
            if (!isNaN(slPrice) && slPrice > 0) slMap.set(ticker, slPrice);
          } else if (type === "limit" || type === "lmt") {
            const tpPrice = parseFloat(o.price ?? o.lmtPrice ?? "");
            if (!isNaN(tpPrice) && tpPrice > 0) tpMap.set(ticker, tpPrice);
          }
        }
      }

      if (posRes.ok) {
        const ibkrPositions: any[] = (posRes.body as any)?.positions ?? [];
        const ibkrMapped = ibkrPositions
          .filter((p: any) => (p.position ?? 0) !== 0)
          .map((p: any) => {
            const ticker = (p.contractDesc ?? p.ticker ?? "?").toUpperCase();
            const signedPos = p.position ?? 0;
            const direction = signedPos > 0 ? "long" : "short";
            const units = Math.abs(signedPos);
            const mktPrice = p.mktPrice ?? 0;
            const avgCost = p.avgCost ?? 0;
            let mktVal = p.mktValue ?? 0;
            // When quotes are stale IBKR may return mktValue=0 — keep the row and estimate from price.
            if (Math.abs(mktVal) < 1 && units > 0) {
              const px = mktPrice > 0 ? mktPrice : avgCost;
              mktVal = px * units * (signedPos < 0 ? -1 : 1);
            }
            const currentPrice = mktPrice > 0
              ? mktPrice
              : (units > 0 && Math.abs(mktVal) > 0 ? Math.abs(mktVal) / units : avgCost);
            return {
              id: p.conid,
              ticker,
              direction,
              units,
              entryPrice: avgCost,
              currentPrice,
              allocatedCapital: Math.abs(mktVal),
              unrealizedPnl: p.unrealizedPnl ?? 0,
              pnl: p.unrealizedPnl ?? 0,
              value: Math.abs(mktVal),
              marketValueSigned: mktVal,
              mktValue: mktVal,
              status: "open",
              openedAt: null,
              signal: "IBKR_LIVE",
              zivScore: null,
              sector: null,
              currentSl: slMap.get(ticker) ?? null,
              currentTp: tpMap.get(ticker) ?? null,
            };
          });

        if (ibkrMapped.length > 0) {
          // ✅ IBKR has live data — use it
          positions = ibkrMapped;
        } else {
          // ⚠️ IBKR returned 0 positions (market closed / session hiccup)
          // Fall back to DB open positions so War Room isn't empty
          const dbPos = await db.select().from(livePositions)
            .where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.status, "open")))
            .orderBy(desc(livePositions.openedAt));
          // Enrich DB positions with SL/TP from live orders if available
          positions = dbPos.map((p: any) => ({
            ...p,
            currentSl: slMap.get(p.ticker) ?? p.currentSl ?? null,
            currentTp: tpMap.get(p.ticker) ?? p.currentTp ?? null,
            signal: "DB_FALLBACK",
          }));
        }
      }
    } catch(e) {
      // fallback to DB if IBKR unavailable
      const dbPos = await db.select().from(livePositions)
        .where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.status, "open")))
        .orderBy(desc(livePositions.openedAt));
      positions = dbPos;
    }

    // ── Enrich IBKR-mapped rows with DB ghost/slot fields (LIVE_OPS_OVERLAY) ──
    if (positions.length > 0) {
      try {
        const tks = positions.map(p => String(p.ticker ?? "").toUpperCase()).filter(Boolean);
        const dbGhost = await db.select({
          ticker: livePositions.ticker,
          id: livePositions.id,
          slotGhost: livePositions.slotGhost,
          countsTowardSlot: livePositions.countsTowardSlot,
          ghostAt: livePositions.ghostAt,
          ghostStage: livePositions.ghostStage,
          slMovedToBreakEven: livePositions.slMovedToBreakEven,
        }).from(livePositions)
          .where(and(
            eq(livePositions.userId, ctx.user.id),
            eq(livePositions.status, "open"),
          ));
        const ghostByTicker = new Map(dbGhost.map(r => [String(r.ticker).toUpperCase(), r]));
        for (const pos of positions) {
          const g = ghostByTicker.get(String(pos.ticker ?? "").toUpperCase());
          if (g) {
            (pos as any).id = g.id;
            (pos as any).slotGhost = g.slotGhost ?? 0;
            (pos as any).countsTowardSlot = g.countsTowardSlot ?? 1;
            (pos as any).ghostAt = g.ghostAt ?? null;
            (pos as any).ghostStage = g.ghostStage ?? null;
            (pos as any).slMovedToBreakEven = g.slMovedToBreakEven ?? 0;
          }
        }
      } catch { /* display-only */ }
    }

    // ── Enrich positions with sector + zivScore from userAssets ───────────
    if (positions.length > 0) {
      try {
        const { userAssets } = await import("../../drizzle/schema");
        const { inArray } = await import("drizzle-orm");
        const tks = positions.map(p => p.ticker);
        const assets = await db.select({
          ticker: userAssets.ticker,
          sector: userAssets.sector,
          score: userAssets.score,
        }).from(userAssets)
          .where(inArray(userAssets.ticker, tks));
        // Deduplicate by ticker
        const assetMap = new Map<string, { sector: string; score: number|null }>();
        for (const a of assets) {
          const cur = assetMap.get(a.ticker);
          if (!cur) {
            assetMap.set(a.ticker, { sector: a.sector, score: a.score ?? null });
          }
        }
        for (const pos of positions) {
          const a = assetMap.get(pos.ticker);
          if (a) {
            (pos as any).sector         = a.sector ?? (pos as any).sector;
            (pos as any).zivEngineScore   = a.score ?? null;
          }
        }
      } catch { /* non-blocking */ }
    }

    // ── Live price update for P&L ──────────────────────────────────────────
    if (positions.length > 0) {
      try {
        const { fetchIbkrLivePricesBatch } = await import("../marketData");
        const { enrichPositionDisplay } = await import("../services/positionDisplay");
        const tickers = [...new Set(positions.map(p => p.ticker))];
        // SINGLE SOURCE OF TRUTH: use the shared cache (no skipCache) so War Room reads the SAME
        // IBKR /quotes values as Holding 1, Deep Analysis and the SSE stream → all screens agree.
        const livePrices = await fetchIbkrLivePricesBatch(tickers);
        for (const pos of positions) {
          const lpObj = typeof (livePrices as any).get === "function" ? (livePrices as any).get(pos.ticker) : (livePrices as any)[pos.ticker];
          const lp = lpObj && typeof lpObj === "object" ? lpObj.price : (typeof lpObj === "number" ? lpObj : null);
          const feedPct    = lpObj && typeof lpObj === "object" ? (lpObj.changePercent ?? null) : null;
          const feedChange = lpObj && typeof lpObj === "object" ? (lpObj.change ?? null) : null;
          const prevClose  = lpObj && typeof lpObj === "object" ? (lpObj.prevClose ?? null) : null;
          // ── ALWAYS TRUST IBKR ──────────────────────────────────────────────────
          // IBKR-sourced positions carry the broker's authoritative mktPrice + unrealizedPnl.
          // NEVER overwrite them with a quote-feed recompute — feed prices/cost-basis can
          // disagree with IBKR and produce P&L that doesn't match the broker (the source of
          // truth). Only DB-fallback positions get priced from the feed.
          const fromIbkr = (pos as any).signal === "IBKR_LIVE";
          // ── SINGLE SOURCE OF TRUTH ────────────────────────────────────────────────
          // Displayed current price + daily come from the shared IBKR /quotes feed
          // (fetchIbkrLivePricesBatch) — the SAME feed Holding 1, Deep Analysis and the SSE
          // stream use — so every screen shows the identical price/daily for a ticker.
          // P&L stays on IBKR's authoritative unrealizedPnl for IBKR positions (the money truth).
          if (lp && lp > 0) {
            if (fromIbkr) {
              // BUG-WR-003 / A10: do NOT overwrite the displayed currentPrice with the
              // /quotes feed price for IBKR-live rows. These rows carry the broker's
              // authoritative /positions mktPrice (set at currentPrice above) — that is
              // the source of truth for the displayed value. Overwriting it with the
              // feed caused display drift vs Holdings/IBKR. Keep mktPrice as displayed;
              // only sync the broker mktPrice to DB so the row stays populated.
              await db.update(livePositions)
                .set({ currentPrice: (pos as any).currentPrice })
                .where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.ticker, pos.ticker), eq(livePositions.status, "open")));
            } else {
              (pos as any).currentPrice = lp;
              const unreal = (lp - pos.entryPrice) * pos.units * (pos.direction === "short" ? -1 : 1);
              (pos as any).unrealizedPnl = +unreal.toFixed(2);
              await db.update(livePositions)
                .set({ currentPrice: lp, unrealizedPnl: +unreal.toFixed(2) })
                .where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.ticker, pos.ticker), eq(livePositions.status, "open")));
            }
          }
          // Daily change from the single feed (current price vs prior close) for ALL positions.
          const mark = (pos as any).currentPrice;
          if (typeof mark === "number" && mark > 0 && prevClose && prevClose > 0) {
            const dc = mark - prevClose;
            (pos as any).dailyChange = +dc.toFixed(2);
            (pos as any).dailyPct    = +((dc / prevClose) * 100).toFixed(2);
          } else {
            (pos as any).dailyPct    = feedPct != null ? +feedPct.toFixed(2) : null;
            (pos as any).dailyChange = feedChange != null ? +feedChange.toFixed(2) : null;
          }
          (pos as any).prevClose = prevClose ?? null;

          const enriched = enrichPositionDisplay({
            direction: pos.direction,
            units: pos.units,
            entryPrice: pos.entryPrice,
            currentPrice: mark,
            dailyChange: (pos as any).dailyChange,
            dailyPct: (pos as any).dailyPct,
            prevClose: (pos as any).prevClose,
            mktValue: (pos as any).marketValueSigned ?? (pos as any).mktValue ?? null,
          });
          (pos as any).marketValueSigned = enriched.marketValueSigned;
          (pos as any).dailyPnlUsd = enriched.dailyPnlUsd;
          (pos as any).dailyPctPosition = enriched.dailyPctPosition;
          (pos as any).dailyPctStock = enriched.dailyPctStock;
        }
      } catch (priceErr: any) {
        console.warn("[LIVE_ENGINE] Price fetch failed:", priceErr.message);
      }
    }

    const capital = computeLiveCapital(config);
    const totalPnl = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    const totalCapital = positions.reduce((s, p) => s + p.allocatedCapital, 0);

    // ── Parallel IBKR fetch via ibindCached (2-layer: mem-cache → IBIND) ─────
    let [acctRes, pnlRes] = await Promise.all([
      ibindCached("GET", "/account/summary", undefined, WAR_ROOM_IBKR_TTL_MS).catch(() => ({ ok: false, status: 503, body: null })),
      ibindCached("GET", "/pnl", undefined, WAR_ROOM_IBKR_TTL_MS).catch(() => ({ ok: false, status: 503, body: null })),
    ]);
    if (!pnlRes.ok) {
      await primeAccountsIfNeeded().catch(() => {});
      invalidateIbkrCache("/pnl");
      pnlRes = await ibindCached("GET", "/pnl", undefined, WAR_ROOM_IBKR_TTL_MS).catch(() => ({ ok: false, status: 503, body: null }));
    }

    // NLV — from /account/summary
    let liveNlv = config.totalNlv ?? 120000;
    const _acctBody: any = acctRes.ok ? acctRes.body : null;
    // /account/summary may return nested: { U16881054: [ { key:"NetLiquidation", amount:... } ] }
    // or flat from the cache proxy: { summary: { netliquidation: { amount } } }
    // Shape 1 (current IBIND): { success, summary: { netliquidation: { amount } } }
    // Shape 2 (legacy):           { U16881054: [ { key:"NetLiquidation", amount } ] }
    let _fetchedNlv: number | undefined;
    if ((_acctBody?.summary?.netliquidation?.amount ?? 0) > 0) {
      _fetchedNlv = _acctBody.summary.netliquidation.amount;
    } else if (Array.isArray(_acctBody?.[LIVE_ACCOUNT_ID])) {
      const _nlvEntry = (_acctBody[LIVE_ACCOUNT_ID] as any[]).find((e: any) =>
        (e?.key ?? e?.tag ?? "").toLowerCase() === "netliquidation");
      _fetchedNlv = _nlvEntry?.amount ?? _nlvEntry?.value;
    }
    if (_fetchedNlv && _fetchedNlv > 0) {
      liveNlv = _fetchedNlv;
      updateLiveConfig(ctx.user.id, { totalNlv: liveNlv }).catch(() => {});
    }

    // ── BROKER WALLET (read-only) — availableFunds + buyingPower from /account/summary ──
    // Same body (_acctBody) the NLV parse above already read; same two shapes (nested
    // `summary.<field>.amount` OR legacy per-account `[{ key, amount }]` array). Pure
    // display surface for the War Room — no gate/sizing/order consumes these. The
    // optimistic-BP ledger (liveOrderExecutor.resyncOptimisticBP) reads broker truth
    // independently; this block never feeds it.
    const _pickAcctField = (...keys: string[]): number | null => {
      for (const k of keys) {
        const nested = _acctBody?.summary?.[k]?.amount ?? _acctBody?.summary?.[k];
        if (typeof nested === "number" && Number.isFinite(nested)) return nested;
      }
      if (Array.isArray(_acctBody?.[LIVE_ACCOUNT_ID])) {
        const wanted = new Set(keys.map((k) => k.toLowerCase()));
        const entry = (_acctBody[LIVE_ACCOUNT_ID] as any[]).find((e: any) =>
          wanted.has(String(e?.key ?? e?.tag ?? "").toLowerCase()));
        const v = entry?.amount ?? entry?.value;
        if (typeof v === "number" && Number.isFinite(v)) return v;
        const vn = Number(v);
        if (Number.isFinite(vn)) return vn;
      }
      return null;
    };
    const _availableFunds = _pickAcctField("availablefunds", "fullavailablefunds", "availableFunds");
    const _buyingPower    = _pickAcctField("buyingpower", "buyingPower");

    // Daily P&L — from /pnl (upnl or flat shape)
    let _dailyPnlUsd = 0;
    const _pnlBody: any = pnlRes.ok ? pnlRes.body : null;
    if (_pnlBody) {
      const partitions: Record<string, any> = _pnlBody.upnl ?? {};
      const keys = Object.keys(partitions);
      if (keys.length > 0) {
        for (const k of keys) {
          if (typeof partitions[k]?.dpl === "number") _dailyPnlUsd += partitions[k].dpl;
        }
      } else {
        _dailyPnlUsd = _pnlBody.daily_pnl ?? _pnlBody.dailyPnl ?? 0;
      }
    }
    const _fromPositionsDaily = sumDailyPnlFromPositions(positions);
    if (Math.abs(_dailyPnlUsd) < 0.01 && _fromPositionsDaily !== 0) {
      _dailyPnlUsd = _fromPositionsDaily;
    }
    // Fallback B: realized P&L from closed positions today (only if still zero)
    if (Math.abs(_dailyPnlUsd) < 0.01) {
        try {
          const _todayStr = new Date().toISOString().split("T")[0];
        const _rows = await db.select({ total: sql<number>`COALESCE(SUM(${livePositions.realizedPnl}), 0)` })
          .from(livePositions).where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.status, "closed"), sql`DATE(${livePositions.closedAt}) = ${_todayStr}`));
        _dailyPnlUsd = _rows[0]?.total ?? 0;
      } catch {}
    }
    const _dailyPnlPct = (_dailyPnlUsd !== 0 && liveNlv > 0)
      ? +(_dailyPnlUsd / Math.max(1, liveNlv - _dailyPnlUsd) * 100).toFixed(2) : 0;

    // Monthly start NAV — read from systemSettings (key "monthlyStartNlv"); literal is last-resort fallback only.
    let _monthlyStartNlv = 152341.92; // fallback if the DB key is missing
    try {
      const [_msRow] = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, "monthlyStartNlv")).limit(1);
      const _msVal = parseFloat(_msRow?.value ?? "");
      if (Number.isFinite(_msVal) && _msVal > 0) _monthlyStartNlv = _msVal;
    } catch {}
    let _allTimeRealizedPnl = 0;
    try {
      const _rr = await db.select({ total: sql<number>`COALESCE(SUM(${livePositions.realizedPnl}), 0)` })
        .from(livePositions).where(eq(livePositions.userId, ctx.user.id));
      _allTimeRealizedPnl = _rr[0]?.total ?? 0;
    } catch {}

    const ibkrGrossPV = positions.reduce((s: number, p: any) => s + (p.value ?? p.allocatedCapital ?? 0), 0);

    // ── IBKR connection status for War Room banner ──────────────────────────
    let ibkrConnected = false;
    let ibkrSessionActive = false;
    let brokerageStealGrace = false;
    let brokerageStealGraceRemainingSec = 0;
    try {
      const { ibindRequest } = await import("./ibkrProxy");
      const healthRes = await ibindRequest("GET", "/health");
      ibkrConnected = healthRes.ok === true;
      const healthBody = healthRes.body as any;
      ibkrSessionActive = healthBody?.session_active === true;
      brokerageStealGrace = healthBody?.brokerage_steal_grace === true;
      brokerageStealGraceRemainingSec = Number(healthBody?.brokerage_steal_grace_remaining_sec ?? 0) || 0;
    } catch { ibkrConnected = false; }

    const dbFallbackCount = positions.filter((p: any) => p.signal === "DB_FALLBACK").length;

    // ── ZIV H Health — live position health (mode-aware, long/short) ─────────
    if (positions.length > 0) {
      try {
        const catalogScores = new Map<string, number | null>();
        for (const pos of positions) {
          const tk = String(pos.ticker ?? "").toUpperCase();
          catalogScores.set(tk, (pos as any).zivEngineScore ?? pos.zivScore ?? null);
        }
        const { enrichLivePositionsWithZivH } = await import("../liveZivHEnrichment");
        await enrichLivePositionsWithZivH(positions, {
          userId: ctx.user.id,
          totalPortfolioValue: liveNlv,
          db,
          catalogScores,
        });
      } catch (zivErr: any) {
        log.warn("SYSTEM", `[liveEngine] ZIV H enrichment failed: ${zivErr?.message ?? zivErr}`);
      }
    }

    const [etRow] = await db.select({ c: sql<number>`COUNT(*)` }).from(livePositions)
      .where(and(eq(livePositions.userId, ctx.user.id), sql`DATE(${livePositions.openedAt}) = CURDATE()`));
    const entriesToday = Number(etRow?.c ?? 0);

    // ── Upcoming candidates: persisted by the WarEngine cycle (~every 20 min) ──
    // Per-candidate contract the WarRoomCandidatesTable consumes. The kronos conviction
    // fields (ziv/kronosAddon/combined/kronosComputedAt) are populated by the WarEngine
    // mapper for DISPLAY/validation; kronosAddon/kronosComputedAt are null when there is
    // no fresh kronos cache row (e.g. kronosComputeEnabled=0). blockReason/sizeUsd flow
    // through from the same persisted JSON.
    let upcomingSignals: Array<{
      ticker: string; direction: string; score: number; signal: string; status: string;
      ziv?: number; kronosAddon?: number | null; combined?: number; kronosComputedAt?: string | null;
      blockReason?: string | null; sizeUsd?: number;
      weeklyState?: string | null; zoneStatus?: "in" | "out" | null;  // Ziv Phase 1 candidates-table columns
      // ── War Room v4.5 (LONG-ONLY) decision-data — persisted by the WarEngine mapper.
      // route/tier/scoreBreakdown/distanceToTriggerPct/readinessPct/abnormalCycle/
      // macroBlocked mirror the SSOT (genesisScore) decision. DISPLAY-ONLY.
      route?: "GOLD_RETEST_WAR" | "GOLD_BREAKOUT_WAR" | null;
      tier?: "Gold Retest" | "Gold Breakout" | null;
      scoreBreakdown?: { base: number; subTotal: number; total: number };
      distanceToTriggerPct?: number;
      readinessPct?: number;
      abnormalCycle?: boolean;
      macroBlocked?: boolean;
      blockReasonRaw?: string;
      // ── Intraday Armed-Watcher status (BUILD-spec F6) — DISPLAY-ONLY chip ──
      // ARMED|CROSSED|HELD_5M|HOT_LIST when the watcher is live and tracking this name;
      // null when the flag is 0 (the watcher writes nothing → map empty → null). NEVER
      // gates an order. fronthand's F7 candidate-table chip consumes this exact field.
      watcherStatus?: "ARMED" | "CROSSED" | "HELD_5M" | "HOT_LIST" | null;
    }> = [];
    let upcomingSignalsTs: number | null = null;   // last time the candidate forecast was computed
    try {
      const { filterOpenFromUpcoming } = await import("../warEngine");
      const heldLong = new Set(
        positions.filter((p: any) => p.direction !== "short").map((p: any) => String(p.ticker ?? "").toUpperCase()),
      );
      const heldShort = new Set(
        positions.filter((p: any) => p.direction === "short").map((p: any) => String(p.ticker ?? "").toUpperCase()),
      );
      const [usRow] = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, "war_upcoming_signals")).limit(1);
      if ((usRow as any)?.value) {
        const parsed = JSON.parse((usRow as any).value);
        // BUG #2 — Snooze: drop active-snoozed tickers from the War Room candidate table (VISIBILITY-only, mirrors the engine entry-scan filter).
        const { getActiveSnoozedTickerSet } = await import("./snooze");
        const snoozedSet = await getActiveSnoozedTickerSet(ctx.user.id);
        // ── Intraday Armed-Watcher status (F6) — DISPLAY-ONLY. Empty when flag=0 (the
        // watcher writes nothing) → watcherStatus null for every row → byte-identical.
        let _watcherStatusMap = new Map<string, string>();
        try {
          const { getWatcherStatusMap } = await import("../intradayArmedWatcher");
          _watcherStatusMap = getWatcherStatusMap();
        } catch { /* watcher status is display-only — never break getStatus */ }
        upcomingSignals = filterOpenFromUpcoming((parsed?.items ?? []) as any[], { heldLong, heldShort })
          .filter((s: any) => !snoozedSet.has(String(s.ticker ?? "").toUpperCase()))
          .slice(0, 10)
          .map((s: any) => ({
            ...s,
            watcherStatus: (_watcherStatusMap.get(String(s.ticker ?? "").toUpperCase()) ?? null) as
              "ARMED" | "CROSSED" | "HELD_5M" | "HOT_LIST" | null,
          }));
        upcomingSignalsTs = typeof parsed?.ts === "number" ? parsed.ts : null;
      }
    } catch { /* preview is non-critical — never break getStatus on a parse error */ }

    // ── Current market regime (display only — persisted each War Engine cycle) ──
    // Read/display plumbing: never feeds any gate/sizing/leverage decision.
    let regime: {
      regime: string; spySlope: number; vol: number;
      longOk: boolean; shortOk: boolean; computedAt: string | null;
    } | null = null;
    try {
      const [rgRow] = await db.select().from(systemSettings)
        .where(eq(systemSettings.key, "war_regime")).limit(1);
      if ((rgRow as any)?.value) {
        const p = JSON.parse((rgRow as any).value);
        regime = {
          regime:    String(p?.regime ?? "NEUTRAL"),
          spySlope:  Number(p?.spySlope ?? 0),
          vol:       Number(p?.vol ?? 0),
          longOk:    Boolean(p?.longOk ?? true),
          shortOk:   Boolean(p?.shortOk ?? true),
          computedAt: typeof p?.computedAt === "string" ? p.computedAt : null,
        };
      }
    } catch { /* regime is display-only — never break getStatus on a parse error */ }

    // ── Leverage (long/short-aware), computed server-side each poll ──
    // Exposure = |currentPrice × units| — the SAME basis the War Room rows and the War Engine
    // budget use (gross deployed), so the leverage shown matches them. (The IBKR /pnl `mv` field
    // under-reports vs gross stock exposure and produced the misleading ~0.7x.)
    const _expOf = (p: any) => Math.abs((p.currentPrice ?? p.entryPrice ?? 0) * (p.units ?? 0));
    const _longExp  = positions.reduce((s: number, p: any) => s + (p.direction === "short" ? 0 : _expOf(p)), 0);
    const _shortExp = positions.reduce((s: number, p: any) => s + (p.direction === "short" ? _expOf(p) : 0), 0);
    const _nlvLev   = liveNlv > 0 ? liveNlv : 1;

    const { countSlotsFromPositions } = await import("../slotCounter");
    const _slotSummary = countSlotsFromPositions(
      positions.map((p: any) => ({
        direction: p.direction,
        status: "open",
        slotGhost: p.slotGhost,
        countsTowardSlot: p.countsTowardSlot,
      })),
      config.maxPositions ?? 12,
    );

    return {
      config: { ...config, totalNlv: liveNlv },
      ibkrConnected,
      ibkrSessionActive,
      brokerageStealGrace,
      brokerageStealGraceRemainingSec,
      dbFallbackCount,
      ibkrMarketOpen: isLiveMarketOpen(),
      positions,
      upcomingSignals,
      upcomingSignalsTs,
      regime,
      summary: {
        openPositions: positions.length,
        slotSummary: _slotSummary,
        entriesToday,
        maxDailyOrders: (config as any).maxDailyOrders ?? 50,
        leverage: {
          gross:    +((_longExp + _shortExp) / _nlvLev).toFixed(2),
          net:      +((_longExp - _shortExp) / _nlvLev).toFixed(2),
          longX:    +(_longExp / _nlvLev).toFixed(2),
          shortX:   +(_shortExp / _nlvLev).toFixed(2),
          longUsd:  +_longExp.toFixed(0),
          shortUsd: +_shortExp.toFixed(0),
        },
        // ── LIVE GROSS cockpit (War Room "LIVE GROSS: X.Xx") — read-only, same
        // broker-truth exposure math as leverage{} above; no behavior change. ──
        liveGross: {
          grossX: +((_longExp + _shortExp) / _nlvLev).toFixed(2),
          longX:  +(_longExp / _nlvLev).toFixed(2),
          shortX: +(_shortExp / _nlvLev).toFixed(2),
          netX:   +((_longExp - _shortExp) / _nlvLev).toFixed(2),
          nlv:    +liveNlv.toFixed(2),
        },
        // ── BROKER WALLET (read-only) — raw IBKR /account/summary truth. Surfaced for
        // the War Room cockpit + to make the optimistic-BP ledger's source visible.
        // null when the gateway read failed / field absent (never fabricated). ──
        availableFunds: _availableFunds == null ? null : +_availableFunds.toFixed(2),
        buyingPower:    _buyingPower == null ? null : +_buyingPower.toFixed(2),
        totalCapital: +totalCapital.toFixed(2),
        totalPnl: +totalPnl.toFixed(2),
        allocatedCapital: +capital.allocatedCapital.toFixed(2),
        availableCapital: +Math.max(0, capital.allocatedCapital - (ibkrGrossPV || totalCapital)).toFixed(2),
        liveNlv: +liveNlv.toFixed(2),
        totalHolding: +(ibkrGrossPV || totalCapital).toFixed(2),
        elzaCashBalance: +Math.max(0, capital.allocatedCapital - (ibkrGrossPV || totalCapital)).toFixed(2),
        intradayCap: +capital.allocatedCapital.toFixed(2),
        overnightCap: +capital.overnightCap.toFixed(2),
        marketOpen: isLiveMarketOpen(),
        monthlyStartNlv: _monthlyStartNlv,
        dailyPnlUsd: _dailyPnlUsd,
        dailyTradeStats: await (async () => {
          try {
            const todayStr = new Date().toISOString().split("T")[0];
            const rows = await db.select({
              side: liveTrades.side,
              cnt: sql<number>`COUNT(*)`,
            })
            .from(liveTrades)
            .where(and(
              eq(liveTrades.userId, ctx.user.id),
              sql`DATE(${liveTrades.executedAt}) = ${todayStr}`,
            ))
            .groupBy(liveTrades.side);
            const buys  = rows.find(r => r.side === "BUY")?.cnt  ?? 0;
            const sells = rows.find(r => r.side === "SELL")?.cnt ?? 0;
            return { buys: Number(buys), sells: Number(sells), total: Number(buys) + Number(sells) };
          } catch { return { buys: 0, sells: 0, total: 0 }; }
        })(),
        dailyPnlPct: _dailyPnlPct,
                // Monthly P&L — IBKR NAV-based (currentNlv - startOfMonthNlv)
        // Primary: IBKR performance/portfolio MTD startNAV
        // Fallback: systemSettings.monthlyStartNlv
        allTimeRealizedPnl: _allTimeRealizedPnl,
      },
    };
  }),

  // ── Update config (start/stop, allocatedPct, maxPositions) ──────────────
  updateConfig: adminProcedure
    .input(z.object({
      isEnabled:            z.number().min(0).max(1).optional(),
      allocatedPct:         z.number().min(0).max(100).optional(),
      maxPositions:         z.number().min(1).max(100).optional(),
      maxLongPositions:     z.number().min(1).max(100).optional(),
      maxShortPositions:    z.number().min(1).max(50).optional(),
      dailyEntryLimit:      z.number().min(1).max(100).optional(),
      positionSizePct:      z.number().min(1).max(100).optional(),
      totalNlv:             z.number().min(0).optional(),
      intradayMultiplier:   z.number().min(0).max(4.0).optional(),  // CEO range 0–4× (0 = pause new entries)
      overnightMultiplier:  z.number().min(0).max(2.0).optional(),  // CEO range 0–2× overnight cap
      minPositionUsd:       z.number().min(0).max(999999).optional(),
      maxPositionUsd:       z.number().min(0).max(999999).optional(),
      maxDailyOrders:       z.number().min(1).max(500).optional(),
      confirmToken:         z.string().min(1).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.isEnabled === 0) {
        requireConfirmToken(ctx.user.id, "engine_off", input.confirmToken);
      }
      const { confirmToken: _ct, ...configPatch } = input;
      await updateLiveConfig(ctx.user.id, configPatch);
      return { ok: true };
    }),

  // ── Get all positions (open + closed) ────────────────────────────────────
  getPositions: adminProcedure
    .input(z.object({ status: z.enum(["open", "closed", "all"]).default("open") }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      if (input.status === "all") {
        return db.select().from(livePositions)
          .where(eq(livePositions.userId, ctx.user.id))
          .orderBy(desc(livePositions.openedAt))
          .limit(100);
      }
      return db.select().from(livePositions)
        .where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.status, input.status)))
        .orderBy(desc(livePositions.openedAt));
    }),

  // ── Manual close position ────────────────────────────────────────────────
  closePosition: adminProcedure
    .input(z.object({ positionId: z.number().optional(), ticker: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const ticker = input.ticker?.toUpperCase().trim();
      const db = await getDb();

      // Prefer DB + executeLiveSell (marketable LMT, bracket cancel, fill tracking)
      if (db && (ticker || input.positionId)) {
        let dbPosId: number | undefined;

        if (ticker) {
          const byTicker = await db.select({ id: livePositions.id }).from(livePositions)
            .where(and(
              eq(livePositions.userId, ctx.user.id),
              eq(livePositions.ticker, ticker),
              inArray(livePositions.status, ["open", "pending_exit", "zombie"]),
            ))
            .limit(1);
          dbPosId = byTicker[0]?.id;
        }

        if (!dbPosId && input.positionId) {
          const byId = await db.select({ id: livePositions.id }).from(livePositions)
            .where(and(
              eq(livePositions.id, input.positionId),
              eq(livePositions.userId, ctx.user.id),
            ))
            .limit(1);
          dbPosId = byId[0]?.id;
        }

        if (dbPosId) {
          log.info("LIVE_EXEC", `closePosition MANUAL_CLOSE ${ticker ?? dbPosId}`, { userId: ctx.user.id, positionId: dbPosId });
          const result = await executeLiveSell({
            userId: ctx.user.id,
            positionId: dbPosId,
            reason: "MANUAL_CLOSE",
          });
          if (!result.success) {
            throw new TRPCError({ code: "BAD_REQUEST", message: result.reason });
          }
          return result;
        }
      }

      // Fallback: no DB row — close directly on IBKR by ticker
      if (ticker) {
        try {
          const { resolveConid } = await import("../liveOrderExecutor");
          const conid = await resolveConid(ticker);
          if (!conid) throw new TRPCError({ code: "BAD_REQUEST", message: `No conid for ${ticker}` });
          if (!LIVE_ACCOUNT_ID) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "IBKR_LIVE_ACCOUNT_ID not configured" });

          const posRes = await ibindRequest("GET", "/positions");
          const ibkrPos = ((posRes.body as any)?.positions ?? []).find((p: any) => {
            const sym = (p.contractDesc ?? p.ticker ?? "").toUpperCase();
            return sym === ticker || sym.startsWith(`${ticker} `);
          });
          if (!ibkrPos || ibkrPos.position === 0) {
            throw new TRPCError({ code: "NOT_FOUND", message: `Position not found on IBKR: ${ticker}` });
          }

          const side = ibkrPos.position > 0 ? "SELL" : "BUY";
          const qty = Math.abs(ibkrPos.position);

          const ordersRes = await ibindRequest("GET", "/orders");
          const allOrders: any[] = (ordersRes.body as any)?.orders ?? [];
          const brackets = allOrders.filter((o: any) => {
            const sym = (o.description1 ?? o.ticker ?? "").toUpperCase();
            return (sym === ticker || sym.startsWith(`${ticker} `)) &&
              ["PreSubmitted", "Submitted"].includes(o.status);
          });
          for (const ord of brackets) {
            await ibindRequest("DELETE", `/iserver/account/${LIVE_ACCOUNT_ID}/order/${ord.orderId}`);
          }

          const mktPrice = ibkrPos.mktPrice ?? ibkrPos.avgCost ?? 0;
          const lmtPrice = side === "SELL"
            ? +(mktPrice * 0.99).toFixed(2)
            : +(mktPrice * 1.01).toFixed(2);

          // ENDPOINT FIX 2026-06-29: /orders/limit 405s on the gateway; route through /orders/close-position.
          const sellRes = await ibindRequest("POST", "/orders/close-position", {
            account_id: LIVE_ACCOUNT_ID,
            conid,
            side,
            quantity: qty,
            orderType: "LMT",
            limitPrice: lmtPrice,
            outsideRth: false,
            tif: "IOC",
            orderRef: `WARROOM_EXIT_${ticker}_${Date.now()}`,
          }, { "X-Confirm-Live-Order": "yes" });

          if (!sellRes.ok) {
            const msg = ((sellRes.body as any)?.message ?? `HTTP ${sellRes.status}`).toString();
            throw new TRPCError({ code: "BAD_REQUEST", message: msg });
          }

          log.info("LIVE_EXEC", `closePosition IBKR-only ${ticker} ${side} x${qty}`, { orderBody: sellRes.body });
          invalidateIbkrCache(["/positions", "/orders"]);
          const orderId = String((sellRes.body as any)?.order_id ?? (sellRes.body as any)?.result?.order_id ?? "");
          return {
            success: true,
            reason: "פקודה נשלחה ל-IBKR",
            orderId: orderId || null,
            orderType: "LMT",
            quantity: qty,
            ticker,
            side: side as "BUY" | "SELL",
          };
        } catch (e: any) {
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e.message ?? "IBKR close failed" });
        }
      }

      throw new TRPCError({ code: "BAD_REQUEST", message: "No ticker or positionId provided" });
    }),

  // ── Manual order — BUY/SELL × open/close long/short (UI manual trading) ─────
  // One pipeline for all four manual intents. OPENS reuse tryLiveEntry, which ALWAYS places an
  // IBKR stop-loss (a live entry is never left naked — this intentionally overrides a UI
  // IBKR stop-loss on every live entry). CLOSES reuse executeLiveSell on a tracked position.
  // Idempotent via clientOrderId: a STALLED-then-resubmit echoes the first result instead of
  // placing a DUPLICATE live order (the #1 manual-trading money risk).
  placeManualOrder: adminProcedure
    .input(z.object({
      ticker: z.string(),
      side: z.enum(["BUY", "SELL"]),
      intent: z.enum(["open_long", "close_long", "open_short", "close_short"]),
      quantity: z.number().positive(),
      slippagePct: z.number().optional(),
      sl: z.number().nullable().optional(),
      tp: z.number().nullable().optional(),
      clientOrderId: z.string().min(8),
    }))
    .mutation(async ({ ctx, input }): Promise<ManualOrderResult> => {
      const ticker = input.ticker.toUpperCase().trim();
      const userId = ctx.user.id;
      const side = input.side;

      // ── Idempotency — block duplicate live orders from a stalled re-submit ──
      const claim = claimManualOrder(input.clientOrderId);
      if (!claim.proceed) {
        if (claim.result) return claim.result;
        throw new TRPCError({ code: "CONFLICT", message: "הזמנה זהה כבר בעיבוד — המתן לתוצאה לפני שליחה חוזרת" });
      }
      const done = (r: ManualOrderResult): ManualOrderResult => { settleManualOrder(input.clientOrderId, r); return r; };

      try {
        const isOpen = input.intent === "open_long" || input.intent === "open_short";
        const direction: "long" | "short" =
          (input.intent === "open_long" || input.intent === "close_long") ? "long" : "short";

        if (isOpen) {
          // OPEN — needs a live price to size the order + brackets. The gateway feed is flaky;
          // if there is no live price we REFUSE (never price a live entry off nothing) and
          // release the idempotency claim so the user can legitimately retry.
          // BUGFIX: fetchLivePrice returns a LivePrice OBJECT (not a number) — extract .price.
          const lp = await fetchLivePrice(ticker).catch(() => null);
          const px = Number(lp?.price ?? 0);
          if (!px || px <= 0 || !isFinite(px)) {
            releaseManualOrder(input.clientOrderId);
            throw new TRPCError({ code: "BAD_REQUEST", message: `אין מחיר חי ל-${ticker} — לא ניתן לתמחר כניסה ידנית` });
          }
          const bars = await fetchBarsForTicker(ticker, 60).catch(() => [] as any[]);
          const fb = calcEntrySlTp({ entryPrice: px, ema50: ema50FromBars(bars), bars, direction });
          const res = await tryLiveEntry({
            userId, ticker, direction,
            signal: `MANUAL_${direction.toUpperCase()}`,
            zivScore: 0,
            currentPrice: px,
            slPrice: input.sl ?? fb.stopLoss,
            tpPrice: input.tp ?? fb.takeProfit,
            positionSizeUsd: input.quantity * px,
            companyName: ticker,
          });
          log.info("LIVE_EXEC", `placeManualOrder ${input.intent} ${ticker} x${input.quantity} → entered=${res.entered} sl=${res.sl} tp=${res.tp}`, { userId, reason: res.reason });
          // C3: surface the REAL orderId + SL/TP the server placed so the UI banner shows verified values
          return done({ success: res.entered, orderId: res.orderId ?? null, sl: res.sl, tp: res.tp, ticker, side, quantity: input.quantity, orderType: "LMT", reason: res.reason });
        }

        // CLOSE — only on a tracked position. Engine-blind positions must be adopted by the
        // sync first (the adoption keystone), so we fail loudly instead of guessing on IBKR.
        const db = await getDb();
        const rows = db ? await db.select({ id: livePositions.id, units: livePositions.units }).from(livePositions)
          .where(and(
            eq(livePositions.userId, userId),
            eq(livePositions.ticker, ticker),
            inArray(livePositions.status, ["open", "pending_exit", "zombie"]),
          )).limit(1) : [];
        const posRow = rows[0];
        if (!posRow) {
          releaseManualOrder(input.clientOrderId);
          throw new TRPCError({ code: "NOT_FOUND", message: `${ticker} לא מנוהל ב-livePositions — הרץ "סנכרן" כדי לאמץ ואז סגור` });
        }
        // C2 FIX (2026-06-25): honour a PARTIAL close. The UI sends the exact qty to close; if it's
        // less than the full position, REDUCE by fraction (executeLivePartialClose) instead of the
        // old behaviour that dumped 100% on any "sell 25%" click. ≥99% = full close.
        const units = Number(posRow.units) || 0;
        const fraction = units > 0 ? Math.min(1, input.quantity / units) : 1;
        let res: { success: boolean; reason: string; orderId?: string };
        if (fraction < 0.99) {
          res = await executeLivePartialClose(
            { userId, positionId: posRow.id, fraction, reason: "MANUAL_PARTIAL_CLOSE" },
            await partialDeps(userId),
          );
        } else {
          const sell = await executeLiveSell({ userId, positionId: posRow.id, reason: "MANUAL_CLOSE" });
          res = { success: sell.success, reason: sell.reason };
        }
        log.info("LIVE_EXEC", `placeManualOrder ${input.intent} ${ticker} (pos ${posRow.id}, frac ${fraction.toFixed(2)}) → success=${res.success}`, { userId, reason: res.reason });
        return done({ success: res.success, orderId: res.orderId ?? null, ticker, side, quantity: input.quantity, orderType: "LMT", reason: res.reason });
      } catch (e: any) {
        if (e instanceof TRPCError) throw e; // pre-broker failures (claim already released where retryable)
        return done({ success: false, orderId: null, ticker, side, quantity: input.quantity, orderType: "MKT", reason: e?.message ?? "manual order failed" });
      }
    }),

  /** Poll exit progress — DB + IBKR position qty + optional order status */
  getExitProgress: adminProcedure
    .input(z.object({
      ticker: z.string(),
      orderId: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const ticker = input.ticker.toUpperCase().trim();
      let dbOpen = false;
      let dbStatus: string | null = null;

      const db = await getDb();
      if (db) {
        const rows = await db.select({ status: livePositions.status, units: livePositions.units })
          .from(livePositions)
          .where(and(
            eq(livePositions.userId, ctx.user.id),
            eq(livePositions.ticker, ticker),
            inArray(livePositions.status, ["open", "pending_exit", "pending_entry", "zombie"]),
          ))
          .limit(1);
        dbOpen = rows.length > 0;
        dbStatus = rows[0]?.status ?? null;
      }

      let ibkrQty = 0;
      try {
        const posRes = await ibindRequest("GET", "/positions");
        const ibkrPos = ((posRes.body as any)?.positions ?? []).find((p: any) => {
          const sym = (p.contractDesc ?? p.ticker ?? "").toUpperCase();
          return sym === ticker || sym.startsWith(`${ticker} `);
        });
        ibkrQty = Math.abs(ibkrPos?.position ?? 0);
      } catch { /* non-blocking */ }

      let orderStatus: string | null = null;
      let orderFound = false;
      let ibkrMessage: string | null = null;
      let avgPrice: number | null = null;

      if (input.orderId) {
        try {
          const ordRes = await ibindRequest("GET", "/orders");
          const orders: any[] = (ordRes.body as any)?.orders ?? [];
          const match = orders.find((o: any) =>
            String(o.orderId ?? o.order_id ?? "") === input.orderId
          );
          if (match) {
            orderFound = true;
            const statusRaw = String(match.status ?? match.orderStatus ?? "").toLowerCase();
            ibkrMessage = String(match.status ?? match.orderStatus ?? "");
            avgPrice = match.avgPrice ?? match.avgFillPrice ?? match.filled_price ?? null;
            if (statusRaw.includes("fill")) orderStatus = "filled";
            else if (statusRaw.includes("cancel")) orderStatus = "cancelled";
            else if (statusRaw.includes("reject")) orderStatus = "rejected";
            else orderStatus = "pending";
          } else {
            orderStatus = "filled_or_gone";
          }
        } catch { /* non-blocking */ }
      }

      // IBKR flat but DB still pending_exit — finalize (War Room manual close)
      if (dbOpen && dbStatus === "pending_exit" && ibkrQty === 0) {
        const finalized = await finalizePendingExit({
          userId: ctx.user.id,
          ticker,
          avgPrice,
        });
        if (finalized) {
          dbOpen = false;
          dbStatus = "closed";
        }
      }

      const done = !dbOpen && ibkrQty === 0;
      let phase: "submitting" | "pending" | "filled" | "position_closed" | "failed" = "pending";
      if (done) phase = "position_closed";
      else if (orderStatus === "rejected" || orderStatus === "cancelled") phase = "failed";
      else if (orderStatus === "filled" || orderStatus === "filled_or_gone") phase = "filled";

      return {
        done,
        dbOpen,
        dbStatus,
        ibkrQty,
        orderStatus,
        orderFound,
        ibkrMessage,
        avgPrice,
        phase,
      };
    }),

  // ── Manual EOD-Trim to overnight (owner-only, DORMANT until clicked) ──────────
  // Invokes the EXISTING runDeleveragingCycle ON DEMAND, bypassing deleverageCron's
  // 22:30 IST time-gate. Same broker-truth exit path (executeLiveSell), same
  // weakest-first (P&L-ascending) selection, same VIX-aware overnight cap when armed.
  // Difference vs cron: Free-Roll positions are immune (excludeFreeRolled) — they've
  // already shed 50% onto a breakeven stop and carry no overnight downside.
  // Non-re-entrant via _manualTrimRunning; idempotent (broker-truth: flat positions
  // are skipped). Places REAL sell orders ONLY on an explicit owner call → inert.
  manualTrimToOvernight: adminProcedure
    .input(z.object({ confirmToken: z.string().min(1) }).optional())
    .mutation(async ({ ctx }) => {
      if (_manualTrimRunning) {
        return {
          trimmed: 0,
          fromGrossX: 0,
          toGrossX: 0,
          freedUsd: 0,
          reason: "ALREADY_RUNNING — a manual EOD-Trim sweep is already in flight; ignored (non-re-entrant).",
        };
      }
      _manualTrimRunning = true;
      try {
        const nlvRead = await fetchLiveNlvAndDayPnl(ctx.user.id).catch(() => null);
        const nlv = nlvRead?.ok && nlvRead.nlvNow > 0 ? nlvRead.nlvNow : 0;

        const res = await runDeleveragingCycle(ctx.user.id, { excludeFreeRolled: true });

        const freedUsd = Math.max(0, res.uvBeforeUsd - res.uvAfterUsd);
        const denom = nlv > 0 ? nlv : 1;
        const fromGrossX = +(res.uvBeforeUsd / denom).toFixed(2);
        const toGrossX = +(res.uvAfterUsd / denom).toFixed(2);

        const reason =
          res.trimmed === 0
            ? (res.uvBeforeUsd > 0
                ? "WITHIN_CAP — deployed exposure already at/under the overnight cap; nothing trimmed."
                : "NO_OPEN_POSITIONS — nothing to trim.")
            : `TRIMMED ${res.trimmed} weakest-first to overnight cap (1.9× base, Free-Roll immune)` +
              (res.failed > 0 ? ` — ${res.failed} exit(s) failed/unfilled, excess may carry overnight (see War-Room alert)` : "");

        log.warn("LIVE_MONITOR",
          `[ManualEOD-Trim] owner-invoked: trimmed=${res.trimmed} failed=${res.failed} freed=$${freedUsd.toFixed(0)} gross ${fromGrossX}× → ${toGrossX}× (nlv $${nlv.toFixed(0)})`,
          { trimmed: res.trimmed, failed: res.failed, freedUsd, fromGrossX, toGrossX, nlv });

        return { trimmed: res.trimmed, fromGrossX, toGrossX, freedUsd, reason };
      } finally {
        _manualTrimRunning = false;
      }
    }),

  // ── Emergency exit ALL ───────────────────────────────────────────────────
  emergencyExit: adminProcedure
    .input(z.object({ confirmToken: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireConfirmToken(ctx.user.id, "emergency_exit", input.confirmToken);
      const result = await emergencyExitAll(ctx.user.id);
      return result;
    }),


  // ── Elza trades from portfolioHoldings (source=elza) ────────────────────
  getElzaTrades: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return {
      open: [], closed: [], totalRealizedPnl: 0, totalUnrealizedPnl: 0,
      monthlyWinStats: { winners: 0, losers: 0, breakeven: 0, total: 0, winRate: 0, monthKey: "" },
    };

    // Open positions from livePositions (source=elza, all created by WarEngine)
    const openPos = await db.select().from(livePositions)
      .where(and(eq(livePositions.userId, ctx.user.id), eq(livePositions.status, "open")))
      .orderBy(desc(livePositions.openedAt));

    // Closed positions from livePositions — filtered to current month (June 1+)
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];
    const closedPos = await db.select().from(livePositions)
      .where(and(
        eq(livePositions.userId, ctx.user.id),
        eq(livePositions.status, "closed"),
        sql`${livePositions.closedAt} >= ${monthStart}`
      ))
      .orderBy(desc(livePositions.closedAt))
      .limit(100);

    // Also check portfolioHoldings tagged as source=elza
    // Filter by source=elza using sql raw to avoid schema type issues
    const elzaHoldings = await db.select().from(portfolioHoldings)
      .where(and(eq(portfolioHoldings.userId, ctx.user.id), sql`${portfolioHoldings.source} = 'elza'`));

    const totalRealizedPnl = closedPos.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
    const totalUnrealizedPnl = openPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

    const winners = closedPos.filter((p) => (p.realizedPnl ?? 0) > 0).length;
    const losers = closedPos.filter((p) => (p.realizedPnl ?? 0) < 0).length;
    const breakeven = closedPos.filter((p) => (p.realizedPnl ?? 0) === 0).length;
    const closedTotal = closedPos.length;
    const winRate = closedTotal > 0 ? Math.round((winners / closedTotal) * 100) : 0;

    return {
      open: openPos,
      closed: closedPos,
      elzaHoldings,
      totalRealizedPnl: +totalRealizedPnl.toFixed(2),
      totalUnrealizedPnl: +totalUnrealizedPnl.toFixed(2),
      totalPnl: +(totalRealizedPnl + totalUnrealizedPnl).toFixed(2),
      monthlyWinStats: {
        winners,
        losers,
        breakeven,
        total: closedTotal,
        winRate,
        monthKey: monthStart.slice(0, 7),
      },
    };
  }),

  // ── Trigger SL monitor manually ─────────────────────────────────────────
  runSlMonitor: adminProcedure.mutation(async ({ ctx }) => {
    await runLiveSlMonitor(ctx.user.id);
    return { ok: true };
  }),


  // ── Allow Short toggle ─────────────────────────────────────────────────────
  getAllowShort: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { enabled: false };
    const rows = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "live_allow_short")).limit(1);
    return { enabled: rows[0]?.value === "1" };
  }),

  setAllowShort: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { ok: false };
      await db.insert(systemSettings)
        .values({ key: "live_allow_short", value: input.enabled ? "1" : "0" } as any)
        .onDuplicateKeyUpdate({ set: { value: input.enabled ? "1" : "0" } });
      return { ok: true };
    }),

  // ── Stop new buys (without disabling full engine) ────────────────────────
  getStopNewBuys: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { stopped: false };
    const rows = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "isNewBuysStopped")).limit(1);
    return { stopped: rows[0]?.value === "true" };
  }),

  setStopNewBuys: adminProcedure
    .input(z.object({
      stopped: z.boolean(),
      confirmToken: z.string().min(1).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.stopped) {
        requireConfirmToken(ctx.user.id, "stop_buy", input.confirmToken);
      }
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.insert(systemSettings)
        .values({ key: "isNewBuysStopped", value: String(input.stopped) })
        .onDuplicateKeyUpdate({ set: { value: String(input.stopped) } });
      return { ok: true, stopped: input.stopped };
    }),

  // ── Blocked tickers (from in-memory log ring) ───────────────────────────────
  getBlockedTickers: adminProcedure.query(async () => {
    try {
      const { getLogRingEntries } = await import("../logger");
      const entries = (getLogRingEntries ? getLogRingEntries() : []) as any[];
      const blockEntries = entries.filter((e: any) => e.level === "BLOCK").slice(0, 50);
      const seen = new Set<string>();
      return blockEntries.map((r: any) => {
        const m = (r.msg ?? "").match(/([A-Z]{1,5}(?:\.TA)?)/);
        const ticker = m ? m[1] : "?";
        return { ticker, guard: r.category ?? "ENGINE", msg: r.msg ?? "", ts: r.ts ?? "" };
      }).filter((x: any) => {
        if (seen.has(x.ticker)) return false;
        seen.add(x.ticker);
        return true;
      }).slice(0, 15);
    } catch { return []; }
  }),

  // ── Live account info from IBKR ─────────────────────────────────────────────
  getLiveAccount: adminProcedure.query(async ({ ctx }) => {
    try {
      const config  = await getLiveConfig(ctx.user.id);
      const acctId  = (config as any)?.accountId ?? LIVE_ACCOUNT_ID;
      const res     = await ibindRequest("GET", `/portfolio/${acctId}/summary`);
      if (!res.ok) return null;
      const s = res.body as any;
      const pick = (k1: string, k2: string) =>
        s?.[k1]?.amount ?? s?.[k1] ?? s?.[k2]?.amount ?? s?.[k2] ?? null;
      return {
        accountId:       acctId,
        excessLiquidity: pick("excessliquidity", "excessLiquidity"),
        marketValue:     pick("netliquidation",  "netLiquidation"),
        buyingPower:     pick("buyingpower",     "buyingPower"),
        cash:            pick("totalcashvalue",  "totalCashValue"),
        grossPositionValue: pick("grosspositionvalue","grossPositionValue"),
      };
    } catch { return null; }
  }),

  // ── Live orders from IBKR — UNIFIED endpoint (client-side filtering) ─────────
  // Returns ALL orders in one request; client filters per tab (ALL/SL/TP/PEND/FILL/CANC)
  getLiveOrders: adminProcedure
    .input(z.object({ filter: z.enum(["ALL","SL","TP","PEND","FILL","CANC"]).default("ALL") }))
    .query(async ({ ctx, input }) => {
      try {
        const res = await ibindRequest("GET", "/orders");
        if (!res.ok) return [];
        const raw: any[] = (res.body as any)?.orders ?? [];
        return raw.map((o: any) => ({
          orderId:   String(o.orderId   ?? o.order_id ?? ""),
          ticker:    o.ticker    ?? o.description1 ?? o.symbol   ?? "",
          side:      (o.side      ?? o.sideStr  ?? "").toUpperCase(),
          orderType: (o.orderType ?? o.origOrderType ?? o.type ?? "").toUpperCase(),
          status:    (o.status    ?? o.order_ccp_status ?? ""),
          qty:       o.totalSize ?? o.remainingQuantity ?? o.quantity ?? o.qty ?? 0,
          price:     o.price     ?? o.avgPrice ?? null,
          tif:       o.timeInForce ?? o.tif ?? "",
          ref:       o.order_ref ?? o.orderRef ?? "",
          filledQty: o.filledQuantity ?? 0,
        })).slice(0, 500);
      } catch { return []; }
    }),

  // ── getAllLiveOrders — single-call unified endpoint (no filter param) ─────────
  getAllLiveOrders: adminProcedure.query(async ({ ctx }) => {
    try {
      const res = await ibindRequest("GET", "/orders");
      if (!res.ok) return [];
      const raw: any[] = (res.body as any)?.orders ?? [];
      return raw.map((o: any) => ({
        orderId:   String(o.orderId   ?? o.order_id ?? ""),
        ticker:    o.ticker    ?? o.description1 ?? o.symbol   ?? "",
        side:      (o.side      ?? o.sideStr  ?? "").toUpperCase(),
        orderType: (o.orderType ?? o.origOrderType ?? o.type ?? "").toUpperCase(),
        status:    (o.status    ?? o.order_ccp_status ?? ""),
        qty:       o.totalSize ?? o.remainingQuantity ?? o.quantity ?? o.qty ?? 0,
        price:     o.price     ?? o.avgPrice ?? null,
        tif:       o.timeInForce ?? o.tif ?? "",
        ref:       o.order_ref ?? o.orderRef ?? "",
        filledQty: o.filledQuantity ?? 0,
      })).slice(0, 500);
    } catch { return []; }
  }),

  // ── Circuit breaker state (live leverage awareness) ─────────────────────────
  getLiveCircuitBreaker: adminProcedure.query(async ({ ctx }) => {
    try {
      const config = await getLiveConfig(ctx.user.id);
      if (!config) return null;
      const { cashBudget, overnightCap, allocatedCapital, isIntraday, multiplier } = computeLiveCapital(config);
      const db = await getDb();
      if (!db) return null;
      // BUG-01 FIX: use IBKR grosspositionvalue — DB livePositions is empty
      let totalDeployed = 0;
      let openCount = 0;
      try {
        const acctRes2 = await ibindRequest("GET", "/account/summary");
        if (acctRes2.ok) {
          const s2 = acctRes2.body as any;
          const gross = s2?.summary?.grosspositionvalue?.amount ?? s2?.grosspositionvalue?.amount ?? 0;
          totalDeployed = Math.abs(gross);
        }
        const posRes2 = await ibindRequest("GET", "/positions");
        if (posRes2.ok) {
          openCount = ((posRes2.body as any)?.positions ?? []).filter((p: any) => p.position !== 0).length;
        }
      } catch { /* fallback to 0 */ }
      const activeCap   = isIntraday ? allocatedCapital : overnightCap;
      const overLimit   = totalDeployed > activeCap + 1000;
      const drawdownPct = activeCap > 0 ? ((totalDeployed - activeCap) / activeCap) * 100 : 0;
      return {
        active:       overLimit,
        cashBudget,
        currentCap:   activeCap,
        overnightCap,
        totalDeployed,
        drawdownPct:  Math.max(0, drawdownPct),
        isIntraday,
        multiplier,
        openCount,
      };
    } catch { return null; }
  }),

  // ── Sync SL/TP: audit & enforce every open position has exactly 1 TP on IBKR ──

  /** Return the last WarEngine scan cycle stats from systemLogs */
  getLastScanStats: adminProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ message: systemLogs.message, createdAt: systemLogs.createdAt })
      .from(systemLogs)
      .where(sql`${systemLogs.message} LIKE '[WarEngine] 🏁 Done%'`)
      .orderBy(desc(systemLogs.createdAt))
      .limit(1);
    if (!rows[0]) return null;
    // Parse: scanned=154 entered=0 managed=0 skipped=1 | regime=NEUTRAL
    const m = rows[0].message.match(/scanned=(\d+).*entered=(\d+).*managed=(\d+).*skipped=(\d+).*regime=(\w+)/);
    if (!m) return null;
    return {
      scanned: parseInt(m[1]),
      entered: parseInt(m[2]),
      managed: parseInt(m[3]),
      skipped: parseInt(m[4]),
      regime: m[5],
      at: rows[0].createdAt,
    };
  }),

  syncSlTp: adminProcedure.mutation(async ({ ctx }) => {
    const { runLiveSlTpEnforcement } = await import("../liveSlTpEnforcement");
    return runLiveSlTpEnforcement(ctx.user.id, "MANUAL");
  }),


  // ── Trade history ────────────────────────────────────────────────────────
  getTradeHistory: adminProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(liveTrades)
        .where(eq(liveTrades.userId, ctx.user.id))
        .orderBy(desc(liveTrades.executedAt))
        .limit(input.limit);
    }),

  // ── WAR REPORT — closed trade-ledger stats (route × weekly × zone) ──────────
  // Spec: docs/ziv-engine-spec/ledger-warreport-spec.md §4.1. The ledger is a VIEW
  // over closed livePositions, projected via tradeLedger.toLedgerRow. CRITICAL: rows
  // whose exitReason is a phantom (no-fill) or no-price (fabricated $0 P&L) close are
  // dropped BEFORE computeStats so they never dilute win-rate / totals. Fully
  // defensive — like getStatus, this read surface must never throw.
  warReport: adminProcedure.query(async ({ ctx }) => {
    const empty = {
      ok: false as boolean,
      overall: computeStats([]),
      byRoute: {} as Record<string, ReturnType<typeof computeStats>>,
      byWeekly: {} as Record<string, ReturnType<typeof computeStats>>,
      byZone: {} as Record<string, ReturnType<typeof computeStats>>,
      pnl: { daily: 0, weekly: 0, sinceInception: 0 },
      droppedCount: 0,
      rows: [] as LedgerRow[],
      todayClosed: [] as LedgerRow[],
    };

    try {
      const db = await getDb();
      if (!db) return empty;

      // Closed rows (status='closed' OR closedAt set), recent window. Bounded so a
      // long-lived account doesn't pull the whole history into memory.
      const rawRows = await db.select().from(livePositions)
        .where(and(
          eq(livePositions.userId, ctx.user.id),
          sql`(${livePositions.status} = 'closed' OR ${livePositions.closedAt} IS NOT NULL)`,
        ))
        .orderBy(desc(livePositions.closedAt))
        .limit(200);

      // Project to canonical ledger rows (pure, never throws).
      const projected = rawRows.map(toLedgerRow);

      // CRITICAL pre-filter — drop phantom (no-fill) + no-price (fabricated $0)
      // closes BEFORE stats. computeStats trusts its input is the measurable set.
      const dropSet = new Set<string>([...PHANTOM_REASONS, ...NO_PRICE_REASONS]);
      const rows = projected.filter(
        (r) => !(r.exitReason !== null && dropSet.has(r.exitReason)),
      );
      const droppedCount = projected.length - rows.length;

      // ── "What happened today" — EVERY real position that closed today ────────
      // The owner wants to SEE every real close today, INCLUDING ones where the exit
      // price wasn't captured (CLOSED_IBKR_NO_PRICE → realizedPnl null → "P&L לא ידוע").
      // Only the entry never-filled PHANTOMS stay hidden (they were never positions = noise).
      // Calendar-today (local server day) boundary; newest first.
      const phantomSet = new Set<string>(PHANTOM_REASONS);
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const startOfTodayMs = startOfToday.getTime();
      const todayClosed = projected
        .filter((r) => r.closedAt !== null && r.closedAt >= startOfTodayMs
          && !(r.exitReason !== null && phantomSet.has(r.exitReason)))
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

      // Daily / weekly / since-inception realized P&L splits over the measurable set.
      // Israel-day boundary kept simple via UTC window math; null pnl excluded.
      const now = Date.now();
      const MS_DAY = 86_400_000;
      const dayCutoff = now - MS_DAY;
      const weekCutoff = now - 7 * MS_DAY;
      let daily = 0;
      let weekly = 0;
      let sinceInception = 0;
      for (const r of rows) {
        if (r.realizedPnl === null) continue;
        sinceInception += r.realizedPnl;
        const at = r.closedAt;
        if (at !== null) {
          if (at >= dayCutoff) daily += r.realizedPnl;
          if (at >= weekCutoff) weekly += r.realizedPnl;
        }
      }

      return {
        ok: true,
        overall: computeStats(rows),
        byRoute: groupBy(rows, (r) => r.route),
        byWeekly: groupBy(rows, (r) => r.weeklyState ?? "—"),
        byZone: groupBy(rows, (r) => r.zoneStatus ?? "—"),
        pnl: {
          daily: +daily.toFixed(2),
          weekly: +weekly.toFixed(2),
          sinceInception: +sinceInception.toFixed(2),
        },
        droppedCount,
        rows,
        todayClosed,
      };
    } catch (err) {
      log.warn("DB", "[warReport] failed, returning empty ledger", {
        err: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }
  }),
};

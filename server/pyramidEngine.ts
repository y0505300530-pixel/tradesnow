/**
 * pyramidEngine.ts — Pyramid / Scale-In Engine v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Scales into live US positions that are winning AND re-confirm a high ZIV score.
 *
 * Rules:
 *   1. Eligibility  — position is "open", NOT blacklisted, NOT already pyramided
 *                     (dedicated pyramidDone flag in DB — NOT the shared exitReason).
 *   2. Score gate   — current ZIV score > 8.5
 *   3. Profit gate  — ≥1% in-profit (long: price > entry*1.01; short: price < entry*0.99)
 *   4. Sizing       — ADD exactly 50% of original units
 *   5. SL for add-on — set at entryPrice of the original position (principal protected)
 *   6. TP for add-on — same TP as original position (inherit)
 *   7. One pyramid   — max 1 scale-in per position (tracked via pyramidDone flag)
 *   8. Daily cap     — respects MAX_DAILY_ORDERS environment variable
 *   9. Blacklist     — blocksElzaEntry() check before any order
 *  10. Telegram      — sends notification on every ADD action
 *
 * Order boundary (v1.1 — 2026-06-25): the add-on is a native IBKR /orders/bracket,
 * built with the SAME field contract as liveOrderExecutor.tryLiveEntry
 * (entryPrice / stopLoss / takeProfit + slOrderType/tpOrderType/ocaGroup), priced
 * off a LIVE, source-gated IBKR quote (fetchIbkrLivePricesBatch → source==='ibkr').
 * NEVER priced off a stale pos.currentPrice / EOD print.
 */

import { getDb }                    from "./db";
import { livePositions, userAssets, ibkrConidCache } from "../drizzle/schema";
import { eq, and }                  from "drizzle-orm";
import { log }                      from "./logger";
import { ibindRequest }             from "./routers/ibkrProxy";
import { sendTelegramMessage }      from "./telegram";
import { fetchBarsForTicker, fetchIbkrLivePricesBatch } from "./marketData";
import { calcZivEngineScore }       from "./zivEngine";
import { blocksElzaEntry }          from "./catalogStatus";
import { validateSlTpDirection }    from "./slCalculator";
import { isLiveMarketOpen, getLiveConfig, assertNotHalted } from "./liveOrderExecutor";

// ── Constants ─────────────────────────────────────────────────────────────────
const PYRAMID_MIN_ZIV_SCORE  = 8.5;
const PYRAMID_MIN_PROFIT_PCT = 0.01;    // ≥1% in-profit (direction-aware)
const PYRAMID_ADD_FRACTION   = 0.5;     // 50% of original units
const PYRAMID_VERSION        = "1.1";

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runPyramidEngine(userId: number): Promise<number> {
  if (!isLiveMarketOpen()) return 0;

  const db = await getDb();
  if (!db) return 0;

  const config = await getLiveConfig(userId);
  if (!config?.isEnabled) return 0;

  // HALT-1 — UNIVERSAL HALT CHOKEPOINT. A circuit-breaker (or Alert-Mode) halt halts the
  // ENTIRE book — scale-ins included. Block at the TOP before any add bracket. INERT when
  // elzaV45LiveEnabled=0 (the latch is never set → assertNotHalted returns blocked:false).
  const pyHalt = assertNotHalted(config);
  if (pyHalt.blocked) {
    log.warn("PYRAMID", `[PyramidEngine] scale-in blocked — ${pyHalt.reason}`);
    return 0;
  }

  // ── Daily order cap check ─────────────────────────────────────────────────
  const maxDailyOrders = parseInt(process.env.MAX_DAILY_ORDERS ?? "30", 10);
  try {
    const ordersRes = await ibindRequest("GET", "/orders");
    if (ordersRes.ok) {
      const allOrders: any[] = (ordersRes.body as any)?.orders ?? [];
      const today = new Date().toISOString().slice(0, 10);
      const todayOrders = allOrders.filter((o: any) => {
        const ts = o.lastExecutionTime ?? o.time ?? "";
        return String(ts).startsWith(today) || String(ts).includes(today.replace(/-/g, ""));
      });
      if (todayOrders.length >= maxDailyOrders) {
        log.warn("PYRAMID", `[PyramidEngine] Daily order cap reached (${todayOrders.length}/${maxDailyOrders}) — skipping`);
        return 0;
      }
    }
  } catch { /* non-fatal — proceed */ }

  // ── Load open positions (long AND short) ──────────────────────────────────
  const openPositions = await db
    .select()
    .from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      eq(livePositions.status, "open"),
    ));

  if (openPositions.length === 0) return 0;

  // ── Load user assets for blacklist check ─────────────────────────────────
  const assets = await db.select().from(userAssets).where(eq(userAssets.userId, userId));

  let addedCount = 0;

  for (const pos of openPositions) {
    try {
      const direction: "long" | "short" = pos.direction === "short" ? "short" : "long";
      const isLong = direction === "long";

      // ── 1. Already pyramided? ───────────────────────────────────────────
      // Dedup on the dedicated pyramidDone flag (NOT the shared exitReason column,
      // which carries real close semantics and must stay null on an OPEN row).
      if ((pos as any).pyramidDone === 1) {
        continue; // already scaled-in once
      }

      // ── 2. Live price (source-gated — never price an add off a stale tick) ─
      // pos.currentPrice is only as fresh as the last runLiveSlMonitor tick; the
      // add LMT MUST be priced off real-time IBKR broker truth (source==='ibkr').
      const priceMap = await fetchIbkrLivePricesBatch([pos.ticker], { skipCache: true });
      const lp = priceMap.get(pos.ticker) ?? null;
      const current = lp?.source === "ibkr" ? Number(lp.price ?? 0) : 0;
      if (!(current > 0)) {
        log.info("PYRAMID", `[PyramidEngine] ${pos.ticker} — no live IBKR price (skip-entry-when-no-live-price)`);
        continue; // never fabricate / price off EOD
      }

      // ── 3. Profit gate (direction-aware) ───────────────────────────────
      const inProfit = isLong
        ? current >= pos.entryPrice * (1 + PYRAMID_MIN_PROFIT_PCT)
        : current <= pos.entryPrice * (1 - PYRAMID_MIN_PROFIT_PCT);
      if (!inProfit) {
        continue; // not enough profit yet
      }

      // ── 4. Blacklist check ──────────────────────────────────────────────
      const asset = assets.find(a => a.ticker.toUpperCase() === pos.ticker.toUpperCase());
      if (blocksElzaEntry(asset?.catalogStatus)) {
        log.info("PYRAMID", `[PyramidEngine] ${pos.ticker} — blocked by catalogStatus=${asset?.catalogStatus}`);
        continue;
      }
      if ((asset as any)?.signalBias === "REJECTED") {
        log.info("PYRAMID", `[PyramidEngine] ${pos.ticker} — blocked by signalBias=REJECTED`);
        continue;
      }

      // ── 5. ZIV Score gate ───────────────────────────────────────────────
      const bars = await fetchBarsForTicker(pos.ticker, 200);
      if (bars.length < 50) continue;

      const ziv = calcZivEngineScore(bars);
      if (ziv.score <= PYRAMID_MIN_ZIV_SCORE) {
        log.info("PYRAMID", `[PyramidEngine] ${pos.ticker} — ZIV score ${ziv.score.toFixed(2)} ≤ ${PYRAMID_MIN_ZIV_SCORE} — skip`);
        continue;
      }

      // ── 6. Sizing + directional SL/TP ───────────────────────────────────
      // Anchor sizing on originalUnits (frozen at first fill) when present, else units.
      const sizeAnchor = (pos as any).originalUnits ?? pos.units;
      const addUnits = Math.max(1, Math.round(sizeAnchor * PYRAMID_ADD_FRACTION));
      // Add-on SL pinned at the ORIGINAL entry price (principal-protected scale-in).
      const addSl    = +pos.entryPrice.toFixed(2);
      // Inherit the original TP; fall back to a directionally-valid 20% target off the live price.
      const addTp    = +(pos.currentTp ?? (isLong ? current * 1.2 : current * 0.8)).toFixed(2);

      // Marketable limit: cross the spread so the add actually fills (BUY +0.5% long, SELL −0.5% short).
      const addEntry = +(isLong ? current * 1.005 : current * 0.995).toFixed(2);

      // ── Same NaN / penny guards the executor enforces (tryLiveEntry) ──────
      // A NaN/0/<$2 price is exactly what trips the gateway's positive-price check
      // and surfaces as `missing_or_bad_field`. Block here, never submit.
      if (!addEntry || isNaN(addEntry) || addEntry <= 0) {
        log.warn("PYRAMID", `[PyramidEngine] ${pos.ticker} — addEntry=${addEntry} (NaN/0/null); skip add`);
        continue;
      }
      if (addEntry < 2 || addSl < 2 || addTp < 2) {
        log.warn("PYRAMID", `[PyramidEngine] ${pos.ticker} — penny guard (entry=$${addEntry} sl=$${addSl} tp=$${addTp} < $2); skip add`);
        continue;
      }

      // Guard: SL/TP must be oriented correctly for the direction or the broker rejects the bracket.
      if (!validateSlTpDirection(addEntry, addSl, addTp, direction)) {
        log.warn("PYRAMID",
          `[PyramidEngine] ${pos.ticker} ${direction} — invalid add SL/TP orientation (entry=$${addEntry} sl=$${addSl} tp=$${addTp}); skip`
        );
        continue;
      }

      // The gateway sidecar enforces a STRICT ordering (BUY: stopLoss < entryPrice < takeProfit;
      // SELL inverted). After 2-decimal rounding a tight level can collapse to an EQUAL value
      // (e.g. entry $2.01 vs sl $2.01) → strict `<` fails → `missing_or_bad_field` / HTTP 400.
      // Require ≥ $0.01 of separation on BOTH legs in the correct direction, else skip the add.
      const slBelowEntry = isLong ? addSl < addEntry : addSl > addEntry;
      const tpBeyondEntry = isLong ? addTp > addEntry : addTp < addEntry;
      if (!slBelowEntry || !tpBeyondEntry
          || Math.abs(addEntry - addSl) < 0.01 || Math.abs(addTp - addEntry) < 0.01) {
        log.warn("PYRAMID",
          `[PyramidEngine] ${pos.ticker} ${direction} — collapsed/too-tight SL/TP gap (entry=$${addEntry} sl=$${addSl} tp=$${addTp}); skip add`
        );
        continue;
      }

      // ── 7. Resolve conid ────────────────────────────────────────────────
      let conid: number | null = null;
      const conidRows = await db
        .select()
        .from(ibkrConidCache)
        .where(eq(ibkrConidCache.symbol, pos.ticker))
        .limit(1);
      if (conidRows[0]?.conid) {
        conid = Number(conidRows[0].conid);
      } else {
        // Fallback: resolve via IBKR search
        try {
          const { resolveConid } = await import("./liveOrderExecutor");
          const resolved = await resolveConid(pos.ticker);
          if (resolved) conid = Number(resolved);
        } catch { /* skip */ }
      }
      if (!conid) {
        log.warn("PYRAMID", `[PyramidEngine] ${pos.ticker} — no conid, skipping scale-in`);
        continue;
      }

      // ── 8. Place bracket order for add-on ──────────────────────────────
      // SAME contract as liveOrderExecutor.tryLiveEntry: entryPrice / stopLoss /
      // takeProfit + slOrderType(STP) / tpOrderType(LMT) / ocaGroup. The old body
      // ({ side, slPrice, tpPrice, accountId }) omitted entryPrice and used the
      // wrong field names → sidecar guard rejected every add (HTTP 400).
      const side    = isLong ? "BUY" : "SELL";
      const ocaGroup = `PYR_OCA_${pos.ticker}_${Date.now()}`;

      log.info("PYRAMID",
        `[PyramidEngine] Scaling into ${pos.ticker} ${direction}: +${addUnits} units @ ~${addEntry.toFixed(2)} | SL=${addSl} TP=${addTp} | ZIV=${ziv.score.toFixed(2)} OCA=${ocaGroup}`
      );

      const bracketBody = {
        conid,
        side,
        quantity: addUnits,
        entryPrice: addEntry,
        stopLoss:   addSl,
        takeProfit: addTp,
        tif: "GTC",
        outsideRth: false,
        ocaGroup,
        slOrderType: "STP",
        tpOrderType: "LMT",
      };

      const res = await ibindRequest("POST", "/orders/bracket", bracketBody, {
        "X-Confirm-Live-Order": "yes",
      });

      if (!res.ok) {
        const errBody = res.body as any;
        log.warn("PYRAMID",
          `[PyramidEngine] ❌ ${pos.ticker} bracket failed: ${errBody?.error ?? errBody?.message ?? "HTTP " + res.status}`
        );
        continue;
      }

      // ── Extract order IDs (same result[] shape as tryLiveEntry) ────────
      const body = res.body as any;
      const resultArr: any[] = Array.isArray(body?.result) ? body.result : [];
      const parentEntry = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-P-"))
                      ?? resultArr.find((r: any) => r.parent_order_id == null && r.order_id)
                      ?? resultArr[0];
      const slEntry     = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-SL-")) ?? resultArr[1];
      const tpEntry     = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-TP-")) ?? resultArr[2];
      const entryOrderId = body?.entryOrderId ?? parentEntry?.order_id ?? null;
      const slOrderId    = body?.slOrderId    ?? slEntry?.order_id     ?? null;
      const tpOrderId    = body?.tpOrderId    ?? tpEntry?.order_id     ?? null;

      // ── 9. Insert child livePosition row ───────────────────────────────
      await db.insert(livePositions).values({
        userId,
        accountId:        pos.accountId,
        ticker:           pos.ticker,
        companyName:      pos.companyName,
        direction,
        units:            addUnits,
        entryPrice:       addEntry,
        allocatedCapital: addUnits * addEntry,
        currentSl:        addSl,
        currentTp:        addTp,
        initialSl:        addSl,
        initialTp:        addTp,
        currentPrice:     current,
        status:           "open",
        signal:           "PYRAMID_ADD",
        zivScore:         ziv.score,
        sector:           pos.sector,
        ibkrEntryOrderId: entryOrderId?.toString() ?? null,
        ibkrSlOrderId:    slOrderId?.toString() ?? null,
        ibkrTpOrderId:    tpOrderId?.toString() ?? null,
        slProtection:     "ibkr",
        rValue:           Math.abs(addEntry - addSl),
        exitReason:       null,  // child position — exitReason reserved for real close semantics
      } as any);

      // ── 10. Mark PARENT pyramided via dedicated fields (NOT exitReason) ─
      await db
        .update(livePositions)
        .set({
          pyramidDone:       1,
          pyramidUnits:      addUnits,
          pyramidEntryPrice: addEntry,
          pyramidSl:         addSl,
          pyramidAt:         new Date(),
          pyramidOrderId:    entryOrderId?.toString() ?? null,
        } as any)
        .where(eq(livePositions.id, pos.id));

      addedCount++;

      // ── 11. Telegram notification ───────────────────────────────────────
      const profitPct = Math.abs(((current / pos.entryPrice) - 1) * 100).toFixed(2);
      const msg =
        `🔺 *PYRAMID ADD* — ${pos.ticker} (${direction})\n` +
        `+${addUnits} units @ ~$${addEntry.toFixed(2)}\n` +
        `Entry (original): $${pos.entryPrice.toFixed(2)} (+${profitPct}% in profit)\n` +
        `New SL: $${addSl.toFixed(2)} (at original entry)\n` +
        `TP: $${addTp.toFixed(2)}\n` +
        `ZIV Score: ${ziv.score.toFixed(2)} ✅\n` +
        `Capital added: ~$${(addUnits * addEntry).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

      await sendTelegramMessage(msg).catch(() => {});

      log.info("PYRAMID",
        `[PyramidEngine] ✅ ADD confirmed for ${pos.ticker} +${addUnits} units | entryOrd=${entryOrderId} slOrd=${slOrderId} tpOrd=${tpOrderId}`
      );

    } catch (e) {
      log.warn("PYRAMID", `[PyramidEngine] Error processing ${pos.ticker}: ${String(e).slice(0, 150)}`);
    }
  }

  if (addedCount > 0) {
    log.info("PYRAMID", `[PyramidEngine v${PYRAMID_VERSION}] Cycle complete — ${addedCount} scale-in(s) executed`);
  }

  return addedCount;
}

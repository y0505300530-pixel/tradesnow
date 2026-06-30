// server/executePartial.ts
// Free-Roll partial-close orchestration. Dependency-injected so the state machine
// is testable with zero real SQL / zero gateway traffic (see scripts/test-partial-close-mocked.ts).
// Real production wiring is in realDeps() — heavy modules are loaded LAZILY (dynamic import),
// so importing this file is side-effect-free.

import { type PartialPos, computePartialPlan, computeMarketableLimit, applyPartialFill } from "./partialCloseLogic";

export interface OrderResult { ok: boolean; orderId?: string; filled?: boolean; reason?: string }

export interface PartialDeps {
  getPosition(id: number): Promise<PartialPos | null>;
  setPosition(id: number, patch: Partial<PartialPos>): Promise<void>;
  /** Atomic: SELECT … FOR UPDATE → mutate → persist; returns the BE stop or null. */
  applyFillTxn(id: number, mutate: (pos: PartialPos) => ReturnType<typeof applyPartialFill>): Promise<number | null>;
  cancelOrder(orderId: string): Promise<void>;
  resolveConid(ticker: string): Promise<number | null>;
  snapshotPrice(ticker: string): Promise<number | null>;
  placeLimitIOC(body: any): Promise<OrderResult>;
  placeStop(body: any): Promise<OrderResult>;
  registerPartial(positionId: number, ticker: string, orderId: string, intent: { qtyToClose: number; fraction: number }): void;
  isDryRun(): boolean;
  log(level: "INFO" | "WARN" | "ERROR", msg: string): void;
}

export async function executeLivePartialClose(
  params: { userId: number; positionId: number; fraction: number; reason: string },
  deps: PartialDeps,
): Promise<{ success: boolean; reason: string; orderId?: string }> {
  const pos = await deps.getPosition(params.positionId);
  if (!pos) return { success: false, reason: "Position not found" };

  const plan = computePartialPlan(pos, params.fraction);
  if (!plan.valid) return { success: false, reason: `invalid plan qty=${plan.qtyToClose}/${pos.units} — use full close` };

  // (1) BRACKET TEARDOWN — cancel full-size SL + TP BEFORE the reduce leg (else they over-sell).
  if (pos.ibkrSlOrderId) await deps.cancelOrder(pos.ibkrSlOrderId);
  if (pos.ibkrTpOrderId) await deps.cancelOrder(pos.ibkrTpOrderId);

  const conid = await deps.resolveConid(pos.ticker);
  if (!conid) return { success: false, reason: `No conid for ${pos.ticker}` };

  const live = (await deps.snapshotPrice(pos.ticker)) ?? pos.currentPrice ?? pos.entryPrice;
  const lmt = computeMarketableLimit(live, plan.exitSide);

  const body = {
    conid, side: plan.exitSide, quantity: plan.qtyToClose,
    orderType: "LMT", price: lmt, tif: "IOC",
    orderRef: `ELZA_PARTIAL_${pos.ticker}_${plan.qtyToClose}of${pos.units}`,
  };

  // dry-run / paper: simulate an immediate fill at the marketable limit
  if (deps.isDryRun()) {
    deps.log("INFO", `[Partial][DRY] ${pos.ticker} ${plan.exitSide} ${plan.qtyToClose}@~$${lmt} tif=IOC`);
    await onPartialExitFilled({ userId: params.userId, positionId: pos.id, qtyClosed: plan.qtyToClose, fillPrice: lmt }, deps);
    return { success: true, reason: "dry-run filled", orderId: "DRYRUN" };
  }

  const res = await deps.placeLimitIOC(body);
  if (!res.ok) return { success: false, reason: res.reason ?? "order rejected" };
  deps.registerPartial(pos.id, pos.ticker, res.orderId ?? "", { qtyToClose: plan.qtyToClose, fraction: params.fraction });
  deps.log("WARN", `[Partial] ${pos.ticker} reduce ${plan.qtyToClose}/${pos.units} placed (${params.reason}) — awaiting fill`);
  return { success: true, reason: "pending fill", orderId: res.orderId };
}

/** Fill-confirmation handler: txn decrement + realize + re-arm BE stop. Called by the poller (or dry-run). */
export async function onPartialExitFilled(
  p: { userId: number; positionId: number; qtyClosed: number; fillPrice: number },
  deps: PartialDeps,
): Promise<void> {
  const beStop = await deps.applyFillTxn(p.positionId, (pos) => applyPartialFill(pos, p.qtyClosed, p.fillPrice));
  if (beStop != null) {
    await replaceStopToBreakeven({ userId: p.userId, positionId: p.positionId, newStop: beStop }, deps);
    deps.log("INFO", `[FreeRoll] pos ${p.positionId} 50% realized @ $${p.fillPrice} — residual STOP armed @ $${beStop}`);
  }
}

/** Cancel the residual stop and arm a fresh standalone STP at newStop (entry-anchored BE). */
export async function replaceStopToBreakeven(
  p: { userId: number; positionId: number; newStop: number },
  deps: PartialDeps,
): Promise<{ success: boolean; reason?: string }> {
  const pos = await deps.getPosition(p.positionId);
  if (!pos) return { success: false, reason: "not found" };
  if (pos.ibkrSlOrderId) await deps.cancelOrder(pos.ibkrSlOrderId);
  const conid = await deps.resolveConid(pos.ticker);
  if (!conid) return { success: false, reason: "no conid" };
  const exitSide: "SELL" | "BUY" = pos.direction === "long" ? "SELL" : "BUY";
  const stp = await deps.placeStop({ conid, side: exitSide, quantity: pos.units, stopPrice: +p.newStop.toFixed(2), tif: "GTC" });
  if (!stp.ok) return { success: false, reason: stp.reason ?? "stop rejected" };
  await deps.setPosition(p.positionId, { ibkrSlOrderId: stp.orderId ?? null });
  return { success: true };
}

// ── Production deps (lazy: heavy modules load only when actually used live) ────
export async function realDeps(userId = 1): Promise<PartialDeps> {
  const [{ getDb }, { ibindRequest }, { resolveConid }, reg, schema, drizzle, { log }, { fetchIbkrLivePricesBatch }] = await Promise.all([
    import("./db"), import("./routers/ibkrProxy"), import("./conidResolver"),
    import("./partialFillRegistry"), import("../drizzle/schema"), import("drizzle-orm"), import("./persistentLogger"),
    import("./marketData"),
  ]);
  const { eq } = drizzle as any;
  const livePositions = (schema as any).livePositions;
  const ACC = process.env.IBKR_ACCOUNT_ID ?? "";
  const db = await getDb();
  return {
    async getPosition(id) { const [r] = await db!.select().from(livePositions).where(eq(livePositions.id, id)).limit(1); return (r as any) ?? null; },
    async setPosition(id, patch) { await db!.update(livePositions).set(patch as any).where(eq(livePositions.id, id)); },
    async applyFillTxn(id, mutate) {
      return await (db as any).transaction(async (tx: any) => {
        const [pos] = await tx.select().from(livePositions).where(eq(livePositions.id, id)).for("update").limit(1);
        if (!pos || pos.status !== "open") return null;
        const next = mutate(pos as any);
        await tx.update(livePositions).set({
          units: next.units, allocatedCapital: next.allocatedCapital, partialRealizedPnl: next.partialRealizedPnl,
          isFreeRolled: 1, currentTp: null, ibkrTpOrderId: null, currentSl: next.currentSl, slMovedToBreakEven: 1,
        }).where(eq(livePositions.id, id));
        return (next as any)._beStop;
      });
    },
    async cancelOrder(orderId) { try { await ibindRequest("DELETE", `/iserver/account/${ACC}/order/${orderId}`); } catch {} },
    resolveConid,
    async snapshotPrice(ticker) {
      // REPOINT 2026-06-25: /iserver/marketdata/snapshot 404s on the OAuth gateway.
      // Use the working POST /quotes pipeline (LivePrice object → .price). Returns null on
      // failure (unchanged contract), so the partial-fill caller skips rather than guesses.
      try {
        const m = await fetchIbkrLivePricesBatch([ticker], { skipCache: true });
        const lp = m.get(ticker) ?? null;
        // QA fix #2: partial-fill re-pricing accepts ONLY real-time IBKR truth. A silent Yahoo/
        // DB-cache fallback (source!=='ibkr') returns null → caller skips rather than pricing the
        // partial off a delayed/stale print.
        const v = lp?.source === 'ibkr' ? Number(lp.price ?? 0) : 0;
        return v > 0 ? v : null;
      } catch { return null; }
    },
    // ENDPOINT FIX 2026-06-29: /orders/limit 405s; route partial reduce LMT through /orders/close-position (price→limitPrice).
    async placeLimitIOC(body) { const { price, ...rest } = body as any; const r = await ibindRequest("POST", "/orders/close-position", { account_id: ACC, ...rest, limitPrice: price, outsideRth: false }, { "X-Confirm-Live-Order": "yes" }); return { ok: r.ok, orderId: String((r.body as any)?.order_id ?? ""), filled: (r.body as any)?.filled, reason: (r.body as any)?.message }; },
    async placeStop(body) { const r = await ibindRequest("POST", "/orders/stop-loss", body, { "X-Confirm-Live-Order": "yes" }); return { ok: r.ok, orderId: String((r.body as any)?.order_id ?? (r.body as any)?.result?.order_id ?? ""), reason: (r.body as any)?.message }; },
    registerPartial: (reg as any).registerPendingPartial,
    isDryRun: () => false,
    log: (lvl, msg) => { const fn = (log as any)?.[lvl.toLowerCase()]; fn ? fn("LIVE_EXEC", msg) : console.log(`[${lvl}] ${msg}`); },
  };
}

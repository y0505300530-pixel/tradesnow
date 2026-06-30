// scripts/test-partial-close-mocked.ts
// In-memory dry run of the Free-Roll partial-close STATE MACHINE.
// Zero real SQL, zero gateway: getDb/IBIND are replaced by injected mock deps.
// Exercises the REAL executeLivePartialClose orchestration (teardown → IOC limit → txn → BE re-arm).
//   run:  npx tsx scripts/test-partial-close-mocked.ts

import { executeLivePartialClose, type PartialDeps } from "../server/executePartial";
import { type PartialPos, computeMarketableLimit, computeBreakeven } from "../server/partialCloseLogic";

const ENTRY = 100, INITIAL_SL = 95, R = 5;     // R = |entry - SL| = 5
const LIVE = ENTRY + 2 * R;                     // +2R trigger = 110

function makeMockDeps(pos: PartialPos) {
  const callLog: string[] = [];
  const placedStops: any[] = [];
  const deps: PartialDeps = {
    async getPosition() { return pos; },
    async setPosition(_id, patch) { Object.assign(pos, patch); callLog.push(`setPosition ${JSON.stringify(patch)}`); },
    async applyFillTxn(_id, mutate) {
      callLog.push("TXN begin (SELECT … FOR UPDATE)");
      const next = mutate(pos);
      Object.assign(pos, {
        units: next.units, allocatedCapital: next.allocatedCapital, partialRealizedPnl: next.partialRealizedPnl,
        isFreeRolled: 1, currentTp: null, ibkrTpOrderId: null, currentSl: next.currentSl,
      });
      callLog.push("TXN commit");
      return (next as any)._beStop;
    },
    async cancelOrder(orderId) { callLog.push(`cancelOrder ${orderId}`); },
    async resolveConid() { return 12345; },
    async snapshotPrice() { return LIVE; },
    async placeLimitIOC(body) { callLog.push(`placeLimitIOC ${body.side} ${body.quantity}@${body.price} tif=${body.tif}`); return { ok: true, orderId: "IOC1", filled: true }; },
    async placeStop(body) { callLog.push(`placeStop ${body.side} ${body.quantity}@stop${body.stopPrice} tif=${body.tif}`); placedStops.push(body); return { ok: true, orderId: "STP_BE_1" }; },
    registerPartial: (_pid, _t, oid) => callLog.push(`registerPartial ${oid}`),
    isDryRun: () => true,
    log: (lvl, msg) => callLog.push(`log ${lvl}: ${msg}`),
  };
  return { deps, callLog, placedStops };
}

async function main() {
  const pos: PartialPos = {
    id: 1, ticker: "TEST", direction: "long", units: 100, entryPrice: ENTRY,
    allocatedCapital: 100 * ENTRY, currentPrice: LIVE, currentSl: INITIAL_SL, currentTp: ENTRY + 3 * R,
    partialRealizedPnl: 0, isFreeRolled: 0, ibkrSlOrderId: "OLD_SL", ibkrTpOrderId: "OLD_TP",
  };
  const { deps, callLog, placedStops } = makeMockDeps(pos);

  const res = await executeLivePartialClose({ userId: 1, positionId: 1, fraction: 0.5, reason: "TEST_2R" }, deps);

  console.log("=== CALL SEQUENCE ===");
  callLog.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c}`));
  console.log("\n=== RESULT ===", JSON.stringify(res));
  console.log("=== FINAL POSITION ===", JSON.stringify({
    units: pos.units, isFreeRolled: pos.isFreeRolled, currentTp: pos.currentTp,
    currentSl: pos.currentSl, partialRealizedPnl: pos.partialRealizedPnl, ibkrSlOrderId: pos.ibkrSlOrderId,
  }));

  const iSL = callLog.findIndex(c => c.includes("cancelOrder OLD_SL"));
  const iTP = callLog.findIndex(c => c.includes("cancelOrder OLD_TP"));
  // exit leg = real placeLimitIOC (live path) OR the [Partial][DRY] simulated fill (dry path)
  const iLeg = callLog.findIndex(c => c.startsWith("placeLimitIOC") || c.includes("[Partial][DRY]"));
  const iTxn = callLog.findIndex(c => c.startsWith("TXN begin"));
  const iStop = callLog.findIndex(c => c.startsWith("placeStop"));
  const expLmt = computeMarketableLimit(LIVE, "SELL");      // 110 × 0.99 = 108.90
  const expBe = computeBreakeven(ENTRY, "long");            // 100 × 1.0015 = 100.15

  const checks: [string, boolean][] = [
    ["teardown: SL cancelled before exit leg", iSL >= 0 && iSL < iLeg],
    ["teardown: TP cancelled before exit leg", iTP >= 0 && iTP < iLeg],
    [`IOC marketable limit = live×0.99 = ${expLmt}`, callLog.some(c => (c.startsWith("placeLimitIOC") || c.includes("[Partial][DRY]")) && c.includes(String(expLmt)) && c.includes("tif=IOC"))],
    ["txn ran (FOR UPDATE) after the exit leg", iTxn > iLeg],
    ["units halved 100 → 50", pos.units === 50],
    ["isFreeRolled = 1", pos.isFreeRolled === 1],
    ["TP removed (null)", pos.currentTp === null],
    [`SL → entry-anchored breakeven ${expBe}`, pos.currentSl === expBe],
    ["partial PnL realized > 0", (pos.partialRealizedPnl ?? 0) > 0],
    ["residual STOP re-armed AFTER txn", iStop > iTxn],
    ["residual STOP sized to remaining 50", placedStops.length === 1 && placedStops[0].quantity === 50 && placedStops[0].stopPrice === expBe],
    ["new stop id persisted", pos.ibkrSlOrderId === "STP_BE_1"],
  ];

  console.log("\n=== ASSERTIONS ===");
  let ok = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? "PASS" : "FAIL"} — ${name}`); ok = ok && pass; }
  console.log(ok ? "\n🟢 STATE MACHINE VERIFIED (0 SQL, 0 gateway)" : "\n🔴 FAILURES — DO NOT WIRE TO LIVE");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("THREW:", e); process.exit(1); });

/**
 * reactivate-position.ts <TICKER> — reactivate a stale/zombie livePositions row from LIVE IBKR data.
 * Read IBKR /positions + /orders, find the matching open position + its working SL/TP, and flip the
 * most-recent non-closed DB row back to 'open' with the broker's units/avgCost/SL/TP. openedAt=now()
 * so the engine's grace window protects it. Aborts unless avg cost + a live SL AND TP are present.
 * Run: node --env-file=.env --import tsx scripts/reactivate-position.ts NET
 */
import { ibindRequest } from "../server/routers/ibkrProxy";
import { getDb } from "../server/db";
import { livePositions } from "../drizzle/schema";
import { and, eq, inArray, desc } from "drizzle-orm";

const ticker = String(process.argv[2] ?? "").toUpperCase().trim();
if (!ticker) { console.error("usage: reactivate-position.ts <TICKER>"); process.exit(2); }
const USER = 1;
const symOf = (p: any) => String(p?.ticker ?? p?.contractDesc ?? p?.symbol ?? "").toUpperCase().trim();
const num = (v: any) => (typeof v === "number" ? v : parseFloat(v) || 0);

async function main() {
  const [posRes, ordRes] = await Promise.all([ibindRequest("GET", "/positions"), ibindRequest("GET", "/orders")]);
  const positions: any[] = Array.isArray(posRes.body) ? posRes.body : ((posRes.body as any)?.positions ?? []);
  const orders: any[] = (ordRes.body as any)?.orders ?? [];
  const ip = positions.find((p) => symOf(p) === ticker && Math.abs(num(p.position)) > 0);
  if (!ip) { console.error(`[reactivate] ${ticker} is NOT open at IBKR — abort`); process.exit(1); }
  const signed = num(ip.position); const qty = Math.abs(signed); const dir = signed > 0 ? "long" : "short";
  const avg = num(ip.avgPrice ?? ip.avgCost); const mkt = num(ip.mktPrice ?? ip.markPrice ?? avg);
  const cover = dir === "long" ? "S" : "B";
  const mine = orders.filter((o) => String(o.ticker ?? o.description1 ?? "").toUpperCase() === ticker
    && String(o.side ?? "").toUpperCase().startsWith(cover) && (o.status === "PreSubmitted" || o.status === "Submitted"));
  const sl = mine.find((o) => { const t = String(o.orderType ?? "").toUpperCase(); return t.startsWith("STOP") || t === "STP" || t.startsWith("TRAIL"); });
  const tp = mine.find((o) => { const t = String(o.orderType ?? "").toUpperCase(); return t === "LMT" || t === "LIMIT"; });
  const slPrice = sl ? num(sl.auxPrice ?? sl.price ?? sl.lmtPrice) : 0;
  const tpPrice = tp ? num(tp.price ?? tp.lmtPrice) : 0;
  if (avg <= 0 || slPrice <= 0 || tpPrice <= 0) { console.error(`[reactivate] ${ticker} missing avg/SL/TP (avg=${avg} SL=${slPrice} TP=${tpPrice}) — abort`); process.exit(1); }

  const db = await getDb();
  const [row] = await db.select().from(livePositions)
    .where(and(eq(livePositions.userId, USER), eq(livePositions.ticker, ticker),
      inArray(livePositions.status, ["zombie", "pending_entry", "pending_exit", "frozen", "pending_halt"] as any)))
    .orderBy(desc(livePositions.id)).limit(1);
  if (!row) { console.error(`[reactivate] ${ticker}: no zombie/stale row found to reactivate`); process.exit(1); }

  await db.update(livePositions).set({
    status: "open", direction: dir as any, units: qty,
    entryPrice: +avg.toFixed(4), allocatedCapital: +(avg * qty).toFixed(2), currentPrice: +mkt.toFixed(4),
    currentSl: +slPrice.toFixed(2), currentTp: +tpPrice.toFixed(2), initialSl: +slPrice.toFixed(2), initialTp: +tpPrice.toFixed(2),
    ibkrSlOrderId: sl ? String(sl.orderId) : null, ibkrTpOrderId: tp ? String(tp.orderId) : null,
    signal: "ADOPTED_IBKR", openedAt: new Date(), closedAt: null as any, exitReason: null as any, realizedPnl: 0,
  } as any).where(eq(livePositions.id, (row as any).id));

  console.log(`[reactivate] ${ticker} row id=${(row as any).id} → OPEN ${dir} ${qty}u | entry $${avg.toFixed(2)} SL $${slPrice.toFixed(2)} TP $${tpPrice.toFixed(2)}`);
  process.exit(0);
}
main().catch((e) => { console.error("[reactivate] ERROR:", e?.message ?? e); process.exit(2); });

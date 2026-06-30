/**
 * audit-sltp.ts — READ-ONLY IBKR ↔ DB protection audit (the "iron rule" checker).
 * Pulls live positions + working orders from IBKR (via the app's own ibindRequest) and
 * compares against the livePositions DB. Reports SL/TP coverage, quantity match, DB drift,
 * zombies, and orphan orders. NEVER places, modifies, or cancels anything.
 *
 * Run on the server:  node --env-file=.env --import tsx scripts/audit-sltp.ts
 *               or:    npm run audit:sltp
 * Exit code: 0 = all protected · 1 = protection gap found · 2 = audit error.
 */
import { ibindRequest } from "../server/routers/ibkrProxy";
import { getDb } from "../server/db";
import { livePositions } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const ACCOUNT = "U16881054";

const symOf = (p: any) => String(p?.ticker ?? p?.contractDesc ?? p?.symbol ?? "").toUpperCase().trim();
const ordSym = (o: any) => String(o?.ticker ?? o?.description1 ?? "").toUpperCase().trim();
const num = (v: any) => (typeof v === "number" ? v : parseFloat(v) || 0);
const ordQty = (o: any) => num(o?.totalSize ?? o?.qty ?? o?.remainingQuantity ?? 0);
const isStop = (o: any) => { const t = String(o?.orderType ?? "").toUpperCase(); return t.startsWith("STOP") || t === "STP" || t.startsWith("TRAIL"); };
const isLimit = (o: any) => { const t = String(o?.orderType ?? "").toUpperCase(); return t === "LMT" || t === "LIMIT"; };

/**
 * Fetch with retry. The ibind gateway intermittently returns a degraded 200 with an
 * empty/missing body (or times out). A SINGLE read that comes back empty made this audit
 * report EVERY position as "MISSING" — a dangerous false-negative (2026-06-25 incident:
 * 4 protected positions reported as 4 gaps). Retry until we get a body that actually
 * carries the expected array; treat persistent failure as INCONCLUSIVE, never as "no orders".
 */
async function fetchListWithRetry(path: "/positions" | "/orders", tries = 4): Promise<{ ok: boolean; arr: any[] }> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await ibindRequest("GET", path);
      const body: any = r?.body;
      const arr: any[] | null = Array.isArray(body)
        ? body
        : (body?.orders ?? body?.positions ?? null);
      if (r?.ok && Array.isArray(arr)) return { ok: true, arr };
    } catch { /* retry */ }
    if (i < tries - 1) await new Promise((s) => setTimeout(s, 1500));
  }
  return { ok: false, arr: [] };
}

async function main() {
  // ── 1. IBKR truth: positions + working orders (retry — gateway returns false-empties) ──
  const [posR, ordR] = await Promise.all([
    fetchListWithRetry("/positions"),
    fetchListWithRetry("/orders"),
  ]);
  // A failed /orders read must NOT be reported as "all unprotected" — that false alarm could
  // trigger duplicate protective orders on a book that is actually already protected.
  if (!ordR.ok || !posR.ok) {
    console.error(`\n[audit-sltp] INCONCLUSIVE — IBKR read failed after retries (positions.ok=${posR.ok} orders.ok=${ordR.ok}). NOT reporting gaps. Retry shortly.\n`);
    process.exit(2);
  }
  const rawPos: any[] = posR.arr;
  const rawOrd: any[] = ordR.arr;
  const openPos = rawPos.filter((p) => Math.abs(num(p?.position)) > 0);
  const activeOrders = rawOrd.filter((o) => o?.status === "PreSubmitted" || o?.status === "Submitted");

  // ── 2. DB view ─────────────────────────────────────────────────────────────
  const db = await getDb();
  const dbPos: any[] = db ? await db.select().from(livePositions).where(eq(livePositions.status, "open")) : [];
  const dbBySym = new Map(dbPos.map((d) => [String(d.ticker).toUpperCase(), d]));
  const ibkrOpenSyms = new Set(openPos.map(symOf));

  console.log(`\n=== SL/TP AUDIT · account ${ACCOUNT} · ${new Date().toISOString()} ===`);
  console.log(`IBKR open positions: ${openPos.length} | working orders: ${activeOrders.length} | DB open rows: ${dbPos.length}\n`);

  // ── 3. per-position protection check (direction-aware: long→SELL cover, short→BUY cover) ──
  let gaps = 0;
  for (const p of openPos) {
    const sym = symOf(p);
    const signed = num(p.position);
    const qty = Math.abs(signed);
    const dir = signed > 0 ? "long" : "short";
    const coverPrefix = dir === "long" ? "S" : "B";
    const mine = activeOrders.filter((o) => ordSym(o) === sym && String(o?.side ?? "").toUpperCase().startsWith(coverPrefix));
    const sl = mine.find(isStop);
    const tp = mine.find(isLimit);
    const qtyOk = !!sl && !!tp && Math.abs(ordQty(sl) - qty) < 1 && Math.abs(ordQty(tp) - qty) < 1;
    if (!sl || !tp) gaps++;
    const flag = sl && tp ? "✅" : "❌ GAP";
    const slStr = sl ? `$${num(sl.auxPrice ?? sl.price ?? sl.lmtPrice).toFixed(2)} (${ordQty(sl)}u)` : "MISSING";
    const tpStr = tp ? `$${num(tp.price ?? tp.lmtPrice).toFixed(2)} (${ordQty(tp)}u)` : "MISSING";
    console.log(`${flag}  ${sym.padEnd(6)} ${dir} ${String(qty).padStart(4)}u   SL=${slStr.padEnd(18)} TP=${tpStr.padEnd(18)} qtyMatch=${qtyOk ? "yes" : "NO"}`);
    const dbRow = dbBySym.get(sym);
    if (dbRow && num(dbRow.units) !== qty) console.log(`        ⚠️ DB units drift: DB=${dbRow.units} vs IBKR=${qty}`);
    if (!dbRow) console.log(`        ⚠️ engine-blind: not in livePositions (no active management)`);
  }

  // ── 4. DB zombies (open in DB, gone at IBKR) ───────────────────────────────
  for (const d of dbPos) {
    if (!ibkrOpenSyms.has(String(d.ticker).toUpperCase())) {
      console.log(`⚠️ DB-zombie: ${d.ticker} is 'open' in DB but not open at IBKR (closed/sold?)`);
    }
  }
  // ── 5. orphan orders (active order, no matching open position) ─────────────
  for (const o of activeOrders) {
    if (ordSym(o) && !ibkrOpenSyms.has(ordSym(o))) {
      console.log(`⚠️ orphan order: ${ordSym(o)} ${o.orderType} ${o.side} #${o.orderId} (no open position)`);
    }
  }

  console.log(`\n=== ${gaps === 0 ? "ALL POSITIONS PROTECTED ✅" : `${gaps} PROTECTION GAP(S) ❌`} ===\n`);
  process.exit(gaps === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[audit-sltp] ERROR:", e?.message ?? e); process.exit(2); });

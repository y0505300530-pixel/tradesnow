/**
 * ibkrQuotesPoller.ts — REST-based live quote polling for open livePositions
 *
 * Polls IBIND POST /quotes every 1.5s for active conids and writes into the
 * shared in-memory price cache (ibkrWebSocket.ts) so liveOrderExecutor /
 * runLiveSlMonitor can read fresh prices without a WebSocket entitlement.
 *
 * Start via startIbkrQuotesPoller() (e.g. from warEngine init).
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { ibkrConidCache, livePositions } from "../../drizzle/schema";
import { ibindRequest } from "../routers/ibkrProxy";
import { upsertRestQuote, getAllPrices } from "./ibkrWebSocket";
import { chunkArray } from "./PriceService";

const POLL_INTERVAL_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;   // on repeated gateway errors, back off up to 30s (no more 1.5s storms)
const HEARTBEAT_EVERY_MS = 30_000;
const CONID_BATCH_SIZE = 50;

export interface QuotesPollerStatus {
  running: boolean;
  tickCount: number;
  lastPollAt: number | null;
  lastUpdated: number;
  lastConidCount: number;
  lastError: string | null;
  cacheSize: number;
}

let _running = false;
let _timer: ReturnType<typeof setInterval> | null = null;
let _pollInFlight = false;
let _tickCount = 0;
let _lastPollAt: number | null = null;
let _lastUpdated = 0;
let _lastConidCount = 0;
let _lastError: string | null = null;
let _lastHeartbeatAt = 0;
let _consecutiveErrors = 0;   // drives the backoff
let _lastErrorLogAt = 0;      // collapse the 503 storm to one log/min

function extractLastPrice(q: Record<string, unknown>): number | null {
  for (const key of ["current_price", "last_price", "snapshot_last", "price"]) {
    const v = q[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function extractChange(q: Record<string, unknown>): number | null {
  const v = q.change ?? q.change_amount;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractChangePct(q: Record<string, unknown>): number | null {
  const v = q.change_percent ?? q.changePercent;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function loadActiveConidTargets(): Promise<Array<{ conid: number; ticker: string }>> {
  const db = await getDb();
  if (!db) return [];

  const openRows = await db
    .select({ ticker: livePositions.ticker })
    .from(livePositions)
    .where(eq(livePositions.status, "open"));

  const tickers = [...new Set(openRows.map(r => r.ticker.toUpperCase().trim()).filter(Boolean))];
  if (tickers.length === 0) return [];

  const lookupSyms = [...new Set(tickers.flatMap(t => (t.endsWith(".TA") ? [t, t.replace(/\.TA$/i, "")] : [t])))];
  const cached = await db
    .select({ symbol: ibkrConidCache.symbol, conid: ibkrConidCache.conid })
    .from(ibkrConidCache)
    .where(inArray(ibkrConidCache.symbol, lookupSyms));

  const conidByTicker = new Map<string, number>();
  for (const row of cached) {
    conidByTicker.set(row.symbol.toUpperCase(), row.conid);
  }

  const targets: Array<{ conid: number; ticker: string }> = [];
  const seenConids = new Set<number>();

  for (const ticker of tickers) {
    const bare = ticker.replace(/\.TA$/i, "");
    const conid = conidByTicker.get(ticker) ?? conidByTicker.get(bare);
    if (conid == null || seenConids.has(conid)) continue;
    seenConids.add(conid);
    targets.push({ conid, ticker });
  }

  // Resolve missing conids via /quotes (symbols path) — one batched call
  const missing = tickers.filter(t => {
    const bare = t.replace(/\.TA$/i, "");
    return conidByTicker.get(t) == null && conidByTicker.get(bare) == null;
  });

  if (missing.length > 0) {
    const ta = missing.filter(t => t.endsWith(".TA"));
    const us = missing.filter(t => !t.endsWith(".TA"));

    const resolveBatch = async (syms: string[], exchange_hint: string) => {
      if (syms.length === 0) return;
      const stripped = syms.map(s => s.replace(/\.TA$/i, "").toUpperCase());
      const res = await ibindRequest("POST", "/quotes", { symbols: stripped, exchange_hint });
      if (!res.ok) return;
      const body = res.body as { quotes?: Record<string, unknown>[] };
      for (let i = 0; i < (body.quotes ?? []).length; i++) {
        const q = body.quotes![i];
        const conid = typeof q.conid === "number" ? q.conid : parseInt(String(q.conid ?? ""), 10);
        if (!conid || seenConids.has(conid)) continue;
        const ticker = syms[i] ?? String(q.symbol ?? q.ticker ?? "").toUpperCase();
        if (!ticker) continue;
        seenConids.add(conid);
        targets.push({ conid, ticker });
      }
    };

    for (const batch of chunkArray(ta, CONID_BATCH_SIZE)) {
      await resolveBatch(batch, "TASE");
    }
    for (const batch of chunkArray(us, CONID_BATCH_SIZE)) {
      await resolveBatch(batch, "SMART");
    }
  }

  return targets;
}

async function fetchQuotesByConids(conids: number[]): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (const batch of chunkArray(conids, CONID_BATCH_SIZE)) {
    const res = await ibindRequest("POST", "/quotes", { conids: batch });
    if (!res.ok) {
      const body = res.body as Record<string, unknown> | undefined;
      if (body?.error === "brokerage_session_grace") {
        const rem = Number(body.grace_remaining_sec) || 300;
        throw new Error(`brokerage_session_grace:${rem}`);
      }
      throw new Error(`POST /quotes HTTP ${res.status}`);
    }
    const body = res.body as { quotes?: Record<string, unknown>[] };
    all.push(...(body.quotes ?? []));
  }
  return all;
}

function maybeHeartbeat(conidCount: number, updated: number): void {
  const now = Date.now();
  if (now - _lastHeartbeatAt < HEARTBEAT_EVERY_MS) return;
  _lastHeartbeatAt = now;
  console.log(
    `[IBKR-QuotesPoller] ♥ heartbeat ticks=${_tickCount} conids=${conidCount} updated=${updated} ` +
    `cacheSize=${getAllPrices().size} lastPoll=${_lastPollAt ? `${Math.round((now - _lastPollAt) / 1000)}s ago` : "never"}`,
  );
}

async function pollOnce(): Promise<void> {
  if (_pollInFlight) return;
  _pollInFlight = true;
  _tickCount++;

  try {
    const targets = await loadActiveConidTargets();
    _lastConidCount = targets.length;

    if (targets.length === 0) {
      _lastPollAt = Date.now();
      _lastError = null;
      maybeHeartbeat(0, 0);
      return;
    }

    const conidToTicker = new Map(targets.map(t => [t.conid, t.ticker]));
    const quotes = await fetchQuotesByConids(targets.map(t => t.conid));

    let updated = 0;
    for (const q of quotes) {
      const conid = typeof q.conid === "number" ? q.conid : parseInt(String(q.conid ?? ""), 10);
      if (!conid) continue;

      const last = extractLastPrice(q);
      if (last == null) continue;

      const ticker =
        conidToTicker.get(conid) ??
        String(q.symbol ?? q.ticker ?? "").toUpperCase();

      upsertRestQuote(conid, ticker, {
        last,
        change: extractChange(q),
        changePct: extractChangePct(q),
        priorClose: typeof q.prior_close === "number" ? q.prior_close : null,
        isDelayed: q.delayed === true || q.is_delayed === true,
      });
      updated++;
    }

    _lastUpdated = updated;
    _lastPollAt = Date.now();
    _lastError = null;
    _consecutiveErrors = 0;   // recovered → resume normal cadence
    maybeHeartbeat(targets.length, updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("brokerage_session_grace:")) {
      const rem = parseInt(msg.split(":")[1] ?? "300", 10) || 300;
      _lastError = `SESSION-STEAL grace — reclaim in ${rem}s`;
      _consecutiveErrors = 0;
      const _now = Date.now();
      if (_now - _lastErrorLogAt > 60_000) {
        _lastErrorLogAt = _now;
        console.info(`[IBKR-QuotesPoller] ${ _lastError } (not competing — owner IBKR app window)`);
      }
    } else {
      _lastError = msg;
      _consecutiveErrors++;
      const _now = Date.now();
      if (_now - _lastErrorLogAt > 60_000) {
        _lastErrorLogAt = _now;
        console.warn(`[IBKR-QuotesPoller] Poll error (${_consecutiveErrors}× consecutive): ${_lastError}`);
      }
    }
  } finally {
    _pollInFlight = false;
  }
}

export function getQuotesPollerStatus(): QuotesPollerStatus {
  return {
    running: _running,
    tickCount: _tickCount,
    lastPollAt: _lastPollAt,
    lastUpdated: _lastUpdated,
    lastConidCount: _lastConidCount,
    lastError: _lastError,
    cacheSize: getAllPrices().size,
  };
}

export function startIbkrQuotesPoller(): void {
  if (_running) {
    console.log("[IBKR-QuotesPoller] Already running");
    return;
  }

  _running = true;
  _lastHeartbeatAt = 0;
  _consecutiveErrors = 0;
  console.log(`[IBKR-QuotesPoller] Starting REST poller (interval=${POLL_INTERVAL_MS}ms, backoff up to ${MAX_BACKOFF_MS}ms on errors)`);

  // Self-scheduling loop: normal cadence on success, exponential backoff while the gateway fails
  // (prevents the 1.5s "POST /quotes 503" storm that floods logs and starves the host).
  void (async function loop(): Promise<void> {
    if (!_running) return;
    await pollOnce();
    if (!_running) return;
    const delay = _lastError?.startsWith("SESSION-STEAL grace")
      ? 30_000
      : _consecutiveErrors > 0
        ? Math.min(POLL_INTERVAL_MS * 2 ** Math.min(_consecutiveErrors, 5), MAX_BACKOFF_MS)
        : POLL_INTERVAL_MS;
    _timer = setTimeout(loop, delay);
  })();
}

export function stopIbkrQuotesPoller(): void {
  if (!_running) return;
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  console.log("[IBKR-QuotesPoller] Stopped");
}

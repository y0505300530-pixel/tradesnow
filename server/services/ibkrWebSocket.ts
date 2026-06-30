/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ibkrWebSocket.ts — IBKR Live Market Data via WebSocket             ║
 * ║  v2.0 — Production-Hardened                                         ║
 * ║                                                                      ║
 * ║  STATUS: ISOLATED MODULE — do NOT connect to War Room or engine      ║
 * ║  until PoC smoke-test validation is complete.                        ║
 * ║                                                                      ║
 * ║  Architecture:                                                       ║
 * ║    Node.js WS ──► wss://api.ibkr.com/v1/api/ws?oauth_token=<LST>    ║
 * ║    ibind /lst     → Live Session Token (OAuth1a, 24h TTL)           ║
 * ║    ibind /session/status → inactivity window (30 min)               ║
 * ║                                                                      ║
 * ║  Hardening added in v2.0:                                           ║
 * ║    • LST expiry-aware reconnect (re-fetches token before expiry)    ║
 * ║    • Session health monitor (polls /session/status every 5 min)     ║
 * ║    • ibind inactivity keepalive (tickles /api/proxy/tickle)         ║
 * ║    • Midnight daily-close detection + scheduled reconnect           ║
 * ║    • Stale-data watchdog (no updates > 90s → reconnect)             ║
 * ║    • Unlimited reconnect with jitter + circuit-breaker (10 fail→off)║
 * ║    • Session-closed close-code 1008 handling                        ║
 * ║                                                                      ║
 * ║  Field mapping (IBKR numeric field IDs → readable):                 ║
 * ║    31   = Last price                                                 ║
 * ║    84   = Bid                                                        ║
 * ║    86   = Ask                                                        ║
 * ║    82   = Change ($)                                                 ║
 * ║    83   = Change (%)                                                 ║
 * ║    7741 = Prior close                                                ║
 * ║    6509 = md_availability ("DB", "DPB", "D"=delayed, etc.)         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import http from 'http';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WsPrice {
  conid: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePct: number | null;
  priorClose: number | null;
  mdAvailability: string | null;
  isDelayed: boolean;
  updatedAt: number; // Date.now()
}

type WsState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'circuit_open';

// ── In-memory price cache ─────────────────────────────────────────────────────
const priceCache = new Map<number, WsPrice>();
const tickerToConid = new Map<string, number>();

export function getPrice(conid: number): WsPrice | null {
  return priceCache.get(conid) ?? null;
}
export function getPriceByTicker(ticker: string): WsPrice | null {
  const conid = tickerToConid.get(ticker.toUpperCase().trim());
  return conid != null ? priceCache.get(conid) ?? null : null;
}
export function getAllPrices(): Map<number, WsPrice> {
  return new Map(priceCache);
}

/** Upsert a REST /quotes row into the shared live price cache (ibkrQuotesPoller). */
export function upsertRestQuote(
  conid: number,
  ticker: string,
  quote: {
    last?: number | null;
    bid?: number | null;
    ask?: number | null;
    change?: number | null;
    changePct?: number | null;
    priorClose?: number | null;
    isDelayed?: boolean;
  },
): void {
  const prev = priceCache.get(conid);
  const price: WsPrice = {
    conid,
    last:          quote.last       ?? prev?.last       ?? null,
    bid:           quote.bid        ?? prev?.bid        ?? null,
    ask:           quote.ask        ?? prev?.ask        ?? null,
    change:        quote.change     ?? prev?.change     ?? null,
    changePct:     quote.changePct  ?? prev?.changePct  ?? null,
    priorClose:    quote.priorClose ?? prev?.priorClose ?? null,
    mdAvailability: prev?.mdAvailability ?? null,
    isDelayed:     quote.isDelayed ?? prev?.isDelayed ?? false,
    updatedAt:     Date.now(),
  };
  if (price.last === null && price.bid === null && price.ask === null) return;

  priceCache.set(conid, price);
  if (ticker) tickerToConid.set(ticker.toUpperCase().trim(), conid);
  lastPriceUpdateAt = Date.now();
  emit(price);
}

// ── Config ────────────────────────────────────────────────────────────────────

const IBKR_WS_URL      = 'wss://api.ibkr.com/v1/api/ws';
const IBIND_HOST       = process.env.IBIND_HOST_OVERRIDE ?? '127.0.0.1';
const IBIND_PORT       = parseInt(process.env.IBIND_PORT_OVERRIDE ?? '5000', 10);
const FIELDS           = ['31', '84', '86', '82', '83', '7741', '6509'];

// Timing
const PING_INTERVAL_MS        = 45_000;   // WS keepalive tic (< IBKR 60s timeout)
const SESSION_POLL_MS         = 5 * 60_000; // session health check cadence
const IBIND_TICKLE_MS         = 20 * 60_000; // ibind inactivity keepalive (< 30 min window)
const STALE_DATA_THRESHOLD_MS = 90_000;   // reconnect if no price updates for 90s
const LST_REFRESH_BEFORE_MS   = 5 * 60_000; // refresh LST 5 min before expiry
const MAX_RECONNECT_CIRCUIT   = 10;       // consecutive failures → circuit_open
const BASE_BACKOFF_MS         = 1_000;
const MAX_BACKOFF_MS          = 60_000;

// ── HMAC signing ──────────────────────────────────────────────────────────────

function buildIbindHeaders(method: string, path: string): Record<string, string> {
  const apiSecret  = process.env.IBIND_API_SECRET  ?? '';
  const hmacSecret = process.env.IBIND_HMAC_SECRET ?? '';
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const msg   = `${method}\n${path}\n${ts}\n${nonce}\n`;
  const sig   = hmacSecret ? crypto.createHmac('sha256', hmacSecret).update(msg).digest('hex') : '';
  return {
    'Authorization': `Bearer ${apiSecret}`,
    'X-Timestamp':   ts,
    'X-Nonce':       nonce,
    'X-Signature':   sig,
  };
}

function ibindGet(path: string, timeoutMs = 6_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const headers = buildIbindHeaders('GET', path);
    const opts = { hostname: IBIND_HOST, port: IBIND_PORT, path, method: 'GET', headers };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`ibind timeout: ${path}`)); });
    req.end();
  });
}

// ── LST cache ─────────────────────────────────────────────────────────────────

interface LstCache {
  token: string;
  expiresMs: number; // absolute epoch ms when token expires
}
let _lstCache: LstCache | null = null;

/**
 * Returns a valid LST.
 * Uses cached value unless it expires within LST_REFRESH_BEFORE_MS.
 * On failure returns null — caller must abort connection attempt.
 */
async function getLiveSessionToken(): Promise<string | null> {
  const now = Date.now();

  // Use cache if still fresh
  if (_lstCache && now < (_lstCache.expiresMs - LST_REFRESH_BEFORE_MS)) {
    console.log(`[IBKR-WS] Using cached LST (expires in ${Math.round((_lstCache.expiresMs - now) / 60_000)}m)`);
    return _lstCache.token;
  }

  try {
    console.log('[IBKR-WS] Fetching fresh LST from ibind /lst ...');
    const data = await ibindGet('/lst');
    const lst       = data?.live_session_token as string | undefined;
    const expiresMs = data?.expires_ms as number | undefined;

    if (!lst) {
      console.warn('[IBKR-WS] /lst returned no token:', data);
      return null;
    }

    // ibind returns expires_ms as an absolute epoch-ms timestamp (from ibkr-client-portal-api).
    // If missing, conservatively assume 23h TTL (IBKR LST is valid 24h).
    const exp = (expiresMs && expiresMs > now) ? expiresMs : now + 23 * 3_600_000;
    _lstCache = { token: lst, expiresMs: exp };

    const minsLeft = Math.round((exp - now) / 60_000);
    console.log(`[IBKR-WS] ✅ LST acquired — expires in ${minsLeft}m`);
    return lst;
  } catch (e: any) {
    console.error('[IBKR-WS] getLiveSessionToken error:', e.message);
    return null;
  }
}

/** Proactively regenerate LST before it expires. Called by sessionMonitor. */
async function _refreshLstIfNeeded(): Promise<void> {
  const now = Date.now();
  if (!_lstCache || now >= (_lstCache.expiresMs - LST_REFRESH_BEFORE_MS)) {
    console.log('[IBKR-WS] LST near expiry — pre-fetching fresh token...');
    const fresh = await getLiveSessionToken();
    if (fresh && wsState === 'connected') {
      // Close current socket gracefully — _onClose will reconnect with new token
      console.log('[IBKR-WS] LST refreshed — cycling WS connection to apply new token');
      _initiateGracefulReconnect('LST_REFRESH');
    }
  }
}

// ── WebSocket state ───────────────────────────────────────────────────────────

let ws: WebSocket | null            = null;
let wsState: WsState                = 'disconnected';
let reconnectAttempts               = 0;
let reconnectTimer: ReturnType<typeof setTimeout>   | null = null;
let pingTimer:      ReturnType<typeof setInterval>  | null = null;
let sessionMonitorTimer: ReturnType<typeof setInterval> | null = null;
let ibindTickleTimer:    ReturnType<typeof setInterval> | null = null;
let staleDataTimer:      ReturnType<typeof setTimeout>  | null = null;
let lastPriceUpdateAt   = 0;
let _lastWsMessageWasWaitingForSession = false; // entitlement detection flag
let _sessionAuthenticated = false;              // IBKR sts.authenticated gate — subscriptions only after this is true

const activeConids = new Set<number>();

type PriceCallback = (price: WsPrice) => void;
const priceCallbacks: PriceCallback[] = [];

export function onPrice(cb: PriceCallback): void { priceCallbacks.push(cb); }
function emit(price: WsPrice): void {
  for (const cb of priceCallbacks) { try { cb(price); } catch { /* ignore */ } }
}

export function getState(): WsState { return wsState; }

// ── Public API ────────────────────────────────────────────────────────────────

export async function connect(): Promise<void> {
  if (wsState === 'connected' || wsState === 'connecting') {
    console.log('[IBKR-WS] Already connected/connecting — skipping');
    return;
  }
  if (wsState === 'circuit_open') {
    console.error('[IBKR-WS] Circuit breaker open — call resetCircuit() before reconnecting');
    return;
  }
  wsState = 'connecting';
  reconnectAttempts = 0;
  console.log('[IBKR-WS] Initiating WebSocket connection...');
  await _openSocket();
}

/** Reset circuit breaker and allow reconnection after manual inspection. */
export function resetCircuit(): void {
  console.log('[IBKR-WS] Circuit breaker reset — ready to reconnect');
  reconnectAttempts = 0;
  wsState = 'disconnected';
}

export function disconnect(): void {
  wsState = 'disconnected';
  _lstCache = null; // invalidate LST on intentional disconnect
  _clearAllTimers();
  _cleanup();
  console.log('[IBKR-WS] Disconnected (manual).');
}

export function subscribe(conid: number): void {
  activeConids.add(conid);
  if (wsState === 'connected' && _sessionAuthenticated) {
    // Session is live and authenticated — send immediately
    _sendSubscribe(conid);
  } else if (wsState === 'connected' && !_sessionAuthenticated) {
    // Socket open but sts.authenticated not yet received — queued, will send on sts
    console.log(`[IBKR-WS] Queued subscription for conid ${conid} (awaiting sts.authenticated)`);
  } else {
    console.log(`[IBKR-WS] Queued subscription for conid ${conid} (not yet connected)`);
  }
}

export function unsubscribe(conid: number): void {
  activeConids.delete(conid);
  _sendUnsubscribe(conid);
}

export function getStatus(): {
  state: WsState;
  conids: number[];
  cacheSize: number;
  reconnectAttempts: number;
  lastPriceUpdateAgo: number | null;
  lstExpiresInMin: number | null;
} {
  const now = Date.now();
  return {
    state: wsState,
    conids: [...activeConids],
    cacheSize: priceCache.size,
    reconnectAttempts,
    lastPriceUpdateAgo: lastPriceUpdateAt ? Math.round((now - lastPriceUpdateAt) / 1000) : null,
    lstExpiresInMin: _lstCache ? Math.round((_lstCache.expiresMs - now) / 60_000) : null,
  };
}

// ── Core connection ───────────────────────────────────────────────────────────

async function _openSocket(): Promise<void> {
  // ── Step 1: Verify ibind session is active ──────────────────────────────
  try {
    const status = await ibindGet('/session/status');
    if (!status?.session_active) {
      console.error('[IBKR-WS] ibind session not active — cannot open WS. Start the IBKR session first.');
      wsState = 'reconnecting';
      _scheduleReconnect();
      return;
    }
  } catch (e: any) {
    console.error('[IBKR-WS] Cannot reach ibind /session/status:', e.message);
    wsState = 'reconnecting';
    _scheduleReconnect();
    return;
  }

  // ── Step 2: Obtain LST ─────────────────────────────────────────────────
  const lst = await getLiveSessionToken();
  if (!lst) {
    console.error('[IBKR-WS] No LST available — aborting connection attempt');
    wsState = 'reconnecting';
    _scheduleReconnect();
    return;
  }

  // ── Step 3: Open WS ────────────────────────────────────────────────────
  const url = `${IBKR_WS_URL}?oauth_token=${encodeURIComponent(lst)}`;
  console.log('[IBKR-WS] Connecting to IBKR WS (oauth_token=***)...');

  // Tear down any previous socket BEFORE opening a new one. removeAllListeners() prevents the
  // EventEmitter/listener + FD leak (the `_maxListeners` dumps + host starvation); terminate()
  // frees the old connection. Because listeners are removed first, the old socket's late
  // close/error can no longer fire a spurious reconnect.
  if (ws) {
    try { ws.removeAllListeners(); ws.terminate(); } catch {}
    ws = null;
  }

  ws = new WebSocket(url, {
    headers: { 'User-Agent': 'ClientPortalGW/1' },
    handshakeTimeout: 10_000,
    rejectUnauthorized: false,
  });

  ws.on('open',    _onOpen);
  ws.on('message', _onMessage);
  ws.on('close',   _onClose);
  ws.on('error',   _onError);
}

// ── Event handlers ────────────────────────────────────────────────────────────

function _onOpen(): void {
  // Mark socket as open but NOT yet authenticated.
  // Subscriptions are withheld until IBKR sends sts.authenticated=true.
  wsState = 'connected';
  _sessionAuthenticated = false;
  reconnectAttempts = 0;
  lastPriceUpdateAt = Date.now();
  console.log('[IBKR-WS] ✅ WebSocket connected to IBKR — awaiting sts.authenticated before subscribing');

  // WS keepalive ping — start immediately (required to keep the handshake alive)
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send('tic');
    }
  }, PING_INTERVAL_MS);

  // Session health + LST expiry monitor
  _startSessionMonitor();

  // ibind inactivity keepalive (ibind closes session after 30 min idle)
  _startIbindTickle();

  // Stale-data watchdog — resets on every price update, fires reconnect after 90s idle
  _resetStaleDataWatchdog();

  // ── Subscriptions are NOT sent here ──────────────────────────────────────
  // IBKR sends {"topic":"sts","args":{"authenticated":true}} after the WS
  // handshake completes. Only then do we subscribe. See _onMessage sts handler.
  // This prevents the "waiting for session" → code=1000 reconnect loop.
}

function _onMessage(raw: Buffer | string): void {
  const text = raw.toString();

  // IBKR keepalive / system messages
  if (text === 'tic' || text.startsWith('system|')) return;

  // Detect "waiting for session" — signals WS entitlement is not available
  _lastWsMessageWasWaitingForSession = false;
  if (text.includes('"waiting for session"') || text.includes('waiting for session')) {
    _lastWsMessageWasWaitingForSession = true;
    console.warn('[IBKR-WS] Received "waiting for session" — WS entitlement likely unavailable for this account.');
    console.warn('[IBKR-WS] If connection closes with code=1000 now, switch to REST polling mode.');
    return;
  }

  let msg: any;
  try { msg = JSON.parse(text); }
  catch {
    if (text.length < 50) return;
    console.warn('[IBKR-WS] Non-JSON message:', text.slice(0, 80));
    return;
  }

  const topic: string = msg?.topic ?? '';

  // ── Session notification from IBKR ──────────────────────────────────────
  // IBKR sends sts topic after WS handshake. Must wait for authenticated=true
  // before sending any smd subscriptions — sending smd before auth causes code=1000.
  if (topic === 'sts') {
    const authenticated = msg?.args?.authenticated ?? msg?.authenticated;
    console.log(`[IBKR-WS] sts received — authenticated=${authenticated}`);

    if (authenticated === true && !_sessionAuthenticated) {
      _sessionAuthenticated = true;
      console.log('[IBKR-WS] ✅ Session authenticated — flushing subscriptions');
      for (const conid of activeConids) {
        _sendSubscribe(conid);
      }
    } else if (authenticated === false) {
      console.warn('[IBKR-WS] ⚠️ IBKR session invalidated (sts topic) — forcing reconnect with fresh LST');
      _sessionAuthenticated = false;
      _lstCache = null; // force LST re-fetch
      _initiateGracefulReconnect('STS_SESSION_DROPPED');
    }
    return;
  }

  // ── Error notification ───────────────────────────────────────────────────
  if (topic === 'error' || msg?.error) {
    console.warn('[IBKR-WS] WS error message:', JSON.stringify(msg).slice(0, 120));
    return;
  }

  // ── Market data ──────────────────────────────────────────────────────────
  if (!topic.startsWith('smd+')) return;

  const conidRaw = msg?.conid ?? msg?.['_conid'];
  const conid = typeof conidRaw === 'number' ? conidRaw : parseInt(conidRaw, 10);
  if (!conid || isNaN(conid)) return;

  const last       = _toNum(msg?.['31']);
  const bid        = _toNum(msg?.['84']);
  const ask        = _toNum(msg?.['86']);
  const change     = _toNum(msg?.['82']);
  const changePct  = _toNum(msg?.['83']);
  const priorClose = _toNum(msg?.['7741']);
  const mdAvail    = msg?.['6509'] ?? null;
  const isDelayed  = msg?.['is_delayed'] === true || mdAvail === 'D';

  if (last === null && bid === null && ask === null) return;

  const prev  = priceCache.get(conid);
  const price: WsPrice = {
    conid,
    last:          last       ?? prev?.last          ?? null,
    bid:           bid        ?? prev?.bid           ?? null,
    ask:           ask        ?? prev?.ask           ?? null,
    change:        change     ?? prev?.change        ?? null,
    changePct:     changePct  ?? prev?.changePct     ?? null,
    priorClose:    priorClose ?? prev?.priorClose    ?? null,
    mdAvailability: mdAvail   ?? prev?.mdAvailability ?? null,
    isDelayed,
    updatedAt: Date.now(),
  };

  priceCache.set(conid, price);
  lastPriceUpdateAt = Date.now();
  _resetStaleDataWatchdog();
  emit(price);

  console.log(
    `[IBKR-WS] 📊 ${conid} | last=${price.last} bid=${price.bid} ask=${price.ask}` +
    ` chg=${price.changePct?.toFixed(2)}% | delayed=${price.isDelayed} | md=${price.mdAvailability}`
  );
}

function _onClose(code: number, reason: Buffer): void {
  const reasonStr = reason.toString().slice(0, 80);
  console.warn(`[IBKR-WS] ⚠️ Disconnected — code=${code} reason="${reasonStr}"`);
  _clearAllTimers();
  _cleanup();

  if (wsState === 'disconnected') return; // manual disconnect — do not reconnect

  // ── Code 1000 + "waiting for session" received = WS entitlement unavailable ──
  // IBKR OAuth1a WS (wss://api.ibkr.com/v1/api/ws) requires a Broker-Dealer WS
  // entitlement. Standard retail accounts (including live U-accounts) receive
  // "waiting for session" then an immediate code=1000 close.
  // This is NOT a transient error — reconnecting will produce the same result.
  // We detect this by checking if the last WS message was "waiting for session".
  if (code === 1000 && _lastWsMessageWasWaitingForSession) {
    console.error('[IBKR-WS] 🚫 WS entitlement unavailable — account does not have OAuth1a WS access.');
    console.error('[IBKR-WS] Falling back to REST polling mode. Use startRestPolling() instead.');
    wsState = 'circuit_open';
    return; // do NOT reconnect — it will loop forever
  }

  // Code 1008 = Policy Violation (IBKR: session/auth expired)
  // Code 4001 = IBKR custom: token expired
  if (code === 1008 || code === 4001) {
    console.warn('[IBKR-WS] Session/token expired (close code ' + code + ') — invalidating LST cache');
    _lstCache = null;
  }

  wsState = 'reconnecting';
  _scheduleReconnect();
}

function _onError(err: Error): void {
  console.error(`[IBKR-WS] ❌ WS error: ${err.message}`);
  // _onClose fires after error — reconnect is handled there
}

// ── Session monitor ───────────────────────────────────────────────────────────

/**
 * Polls ibind /session/status every SESSION_POLL_MS.
 * Detects:
 *   1. Session dropped by ibind inactivity timeout (30 min)
 *   2. ibind daily midnight auto-close
 *   3. LST near expiry → pre-fetches fresh token
 */
function _startSessionMonitor(): void {
  if (sessionMonitorTimer) clearInterval(sessionMonitorTimer);
  sessionMonitorTimer = setInterval(async () => {
    if (wsState !== 'connected') return;
    try {
      const status = await ibindGet('/session/status');
      if (!status?.session_active) {
        console.warn('[IBKR-WS] 🔴 Session monitor: ibind session is NOT active — reconnecting');
        _lstCache = null;
        _initiateGracefulReconnect('SESSION_MONITOR_DEAD');
        return;
      }
      // Check LST expiry proactively
      await _refreshLstIfNeeded();
    } catch (e: any) {
      console.warn('[IBKR-WS] Session monitor check failed (non-fatal):', e.message);
    }
  }, SESSION_POLL_MS);
}

/**
 * Sends a tickle to ibind every 20 min to prevent the 30-min inactivity close.
 * This is a belt-and-suspenders guard: ibind has its own tickler thread, but
 * if ibind's tickler stalls, this ensures the session stays warm.
 */
function _startIbindTickle(): void {
  if (ibindTickleTimer) clearInterval(ibindTickleTimer);
  ibindTickleTimer = setInterval(async () => {
    if (wsState !== 'connected') return;
    try {
      await ibindGet('/api/proxy/tickle');
      console.log('[IBKR-WS] ibind tickle sent');
    } catch (e: any) {
      console.warn('[IBKR-WS] ibind tickle failed (non-fatal):', e.message);
    }
  }, IBIND_TICKLE_MS);
}

/**
 * Stale-data watchdog — if we haven't received any price update in
 * STALE_DATA_THRESHOLD_MS (90s), the subscriptions may have silently died.
 * Force a full reconnect to re-subscribe.
 */
function _resetStaleDataWatchdog(): void {
  if (staleDataTimer) clearTimeout(staleDataTimer);
  if (activeConids.size === 0) return; // nothing subscribed — no data expected
  staleDataTimer = setTimeout(() => {
    if (wsState === 'connected') {
      console.warn(`[IBKR-WS] ⏰ Stale data — no updates for ${STALE_DATA_THRESHOLD_MS / 1000}s — reconnecting`);
      _initiateGracefulReconnect('STALE_DATA');
    }
  }, STALE_DATA_THRESHOLD_MS);
}

// ── Reconnect logic ───────────────────────────────────────────────────────────

function _initiateGracefulReconnect(reason: string): void {
  console.log(`[IBKR-WS] Initiating graceful reconnect (reason: ${reason})`);
  wsState = 'reconnecting';
  _sessionAuthenticated = false;
  if (ws) {
    try { ws.close(1000, 'graceful_reconnect'); } catch { /* ignore */ }
  }
  _clearAllTimers();
  _cleanup();
  _scheduleReconnect();
}

function _scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_CIRCUIT) {
    console.error(`[IBKR-WS] 🚫 Circuit breaker open after ${MAX_RECONNECT_CIRCUIT} consecutive failures.`);
    console.error('[IBKR-WS] Manual intervention required. Call resetCircuit() + connect() to retry.');
    wsState = 'circuit_open';
    return;
  }

  reconnectAttempts++;
  // Exponential backoff with ±20% jitter to avoid thundering-herd
  const base  = Math.min(BASE_BACKOFF_MS * Math.pow(2, reconnectAttempts - 1), MAX_BACKOFF_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  const delay = Math.round(base + jitter);

  console.log(`[IBKR-WS] Reconnect ${reconnectAttempts}/${MAX_RECONNECT_CIRCUIT} in ${delay}ms...`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => _openSocket(), delay);
}

// ── Subscription helpers ──────────────────────────────────────────────────────

function _sendSubscribe(conid: number): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const payload = `smd+${conid}+${JSON.stringify({ fields: FIELDS })}`;
  ws.send(payload);
  console.log(`[IBKR-WS] ✅ Subscribed to conid ${conid}`);
}

function _sendUnsubscribe(conid: number): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(`umd+${conid}+{}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function _cleanup(): void {
  ws?.removeAllListeners();
  ws = null;
}

function _clearAllTimers(): void {
  if (pingTimer)          { clearInterval(pingTimer);          pingTimer = null; }
  if (sessionMonitorTimer){ clearInterval(sessionMonitorTimer);sessionMonitorTimer = null; }
  if (ibindTickleTimer)   { clearInterval(ibindTickleTimer);   ibindTickleTimer = null; }
  if (staleDataTimer)     { clearTimeout(staleDataTimer);      staleDataTimer = null; }
  if (reconnectTimer)     { clearTimeout(reconnectTimer);      reconnectTimer = null; }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _toNum(v: any): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

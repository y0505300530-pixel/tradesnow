/**
 * IBKR Session Monitor — IBIND only
 *
 * Runs every 60 seconds. Checks IBIND /health to detect session expiry.
 *
 * Auto-reconnect logic:
 *   - When session becomes inactive (socket hang up, timeout, or session_active=false),
 *     automatically calls POST /session/start to re-establish the IBKR OAuth session.
 *   - Reconnect cooldown: 5 minutes between attempts (prevents reconnect storms).
 *   - After 3 consecutive failed reconnect attempts, sends a Telegram alert.
 *   - Sends a Telegram alert ONCE when the session transitions from active → inactive
 *     (only if auto-reconnect also fails).
 */

import { sendTelegramMessage } from "./telegram";
import { log } from "./logger";
import { ibindRequest, isIbindManuallyDisconnected, refreshIbindDisconnectFlag } from "./routers/ibkrProxy";
import { autoFillConids } from "./autoFillConids";
import { getIbindLatency } from "./ibkrCache";

const CHECK_INTERVAL_MS     = 60_000;   // check every 60s
const RECONNECT_COOLDOWN_MS = 5 * 60_000; // min 5 min between reconnect attempts
const MAX_RECONNECT_ATTEMPTS = 3;        // alert after this many consecutive failures

// ── State ─────────────────────────────────────────────────────────────────────
let wasSessionActive        = true;
let alertSentForCurrentExpiry = false;
let lastReconnectAt         = 0;
let consecutiveReconnectFails = 0;
let reconnectInProgress     = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Attempt to re-establish the IBKR session via IBIND POST /session/start.
 * Returns true if the session was successfully restored.
 */
async function tryReconnect(): Promise<boolean> {
  // If admin manually disconnected IBIND — never auto-reconnect
  if (isIbindManuallyDisconnected()) {
    log.debug("IBKR", "[SessionMonitor] IBIND manually disconnected — skipping auto-reconnect");
    return false;
  }

  if (reconnectInProgress) {
    log.debug("IBKR", "[SessionMonitor] Reconnect already in progress — skipping");
    return false;
  }

  const now = Date.now();
  if (now - lastReconnectAt < RECONNECT_COOLDOWN_MS) {
    const waitSec = Math.ceil((RECONNECT_COOLDOWN_MS - (now - lastReconnectAt)) / 1000);
    log.debug("IBKR", `[SessionMonitor] Reconnect cooldown — ${waitSec}s remaining`);
    return false;
  }

  reconnectInProgress = true;
  lastReconnectAt = now;

  try {
    log.info("IBKR", "[SessionMonitor] Session inactive — attempting auto-reconnect via /session/start");
    const { ok, body } = await ibindRequest("POST", "/session/start");
    const data = body as Record<string, any>;
    const sessionActive = ok && (data?.session_active === true || data?.session_active === "true" || data?.already_active === true);

    if (sessionActive) {
      log.info("IBKR", "[SessionMonitor] Auto-reconnect SUCCESS — session restored", {
        accountId: data?.account_id ?? null,
        alreadyActive: data?.already_active ?? false,
      });
      consecutiveReconnectFails = 0;
      reconnectInProgress = false;
      return true;
    } else {
      consecutiveReconnectFails++;
      log.warn("IBKR", `[SessionMonitor] Auto-reconnect attempt failed (${consecutiveReconnectFails}/${MAX_RECONNECT_ATTEMPTS})`, {
        ok, status: data?.status, error: data?.error,
      });
      reconnectInProgress = false;
      return false;
    }
  } catch (err: any) {
    consecutiveReconnectFails++;
    log.warn("IBKR", `[SessionMonitor] Auto-reconnect exception (${consecutiveReconnectFails}/${MAX_RECONNECT_ATTEMPTS})`, {
      error: err?.message,
    });
    reconnectInProgress = false;
    return false;
  }
}

async function runMonitorCycle() {
  // Refresh manually-disconnected flag from DB at start of each cycle
  await refreshIbindDisconnectFlag();

  try {
    const { ok, body } = await ibindRequest("GET", "/health");
    const data = body as {
      session_active?: boolean | string;
      status?: string;
      brokerage_steal_grace_remaining_sec?: number;
    };
    const graceRem = Number(data.brokerage_steal_grace_remaining_sec ?? 0);
    if (graceRem > 0) {
      log.info("IBKR", `[SessionMonitor] Brokerage steal grace — ${graceRem}s until gateway reclaim (no auto-reconnect)`);
      return;
    }
    const isActive = ok && (data.session_active === true || (data.session_active as unknown) === "true") && data.status === "ok";

    if (!isActive) {
      // ── Session is inactive ──────────────────────────────────────────────────
      if (wasSessionActive) {
        // Transition: active → inactive
        if (isIbindManuallyDisconnected()) {
          log.debug("IBKR", "[SessionMonitor] IBIND manually disconnected — not triggering reconnect");
        } else {
          log.warn("IBKR", "[SessionMonitor] Session became inactive — triggering auto-reconnect");
        }
        wasSessionActive = false;
        alertSentForCurrentExpiry = false;
        consecutiveReconnectFails = 0;
      }
      // If manually disconnected — skip everything, just wait
      if (isIbindManuallyDisconnected()) return;

      // Attempt auto-reconnect
      const restored = await tryReconnect();

      if (restored) {
        // Session restored — treat as active again
        wasSessionActive = true;
        alertSentForCurrentExpiry = false;
        return;
      }

      // Reconnect failed — send Telegram alert if threshold reached (skip if manually disconnected)
      if (!alertSentForCurrentExpiry && consecutiveReconnectFails >= MAX_RECONNECT_ATTEMPTS && !isIbindManuallyDisconnected()) {
        alertSentForCurrentExpiry = true;
        log.warn("IBKR", "[SessionMonitor] Auto-reconnect failed repeatedly — sending Telegram alert");
        await sendTelegramMessage(
          `⚠️ <b>IBKR Session Disconnected</b>\n\n` +
          `The IBKR session has been inactive and ${MAX_RECONNECT_ATTEMPTS} auto-reconnect attempts failed.\n\n` +
          `Please go to <b>trade-snow2.vip → Settings → IBKR</b> and reconnect manually.`
        ).catch(() => {});
      }

    } else {
      // ── Session is active ────────────────────────────────────────────────────
      if (!wasSessionActive) {
        log.info("IBKR", "[SessionMonitor] Session restored — resetting reconnect state");
        alertSentForCurrentExpiry = false;
        consecutiveReconnectFails = 0;
        // Auto-fill missing conids in the background (fire-and-forget)
        autoFillConids().catch(() => {});
      }
      wasSessionActive = true;
    }
  } catch (err: any) {
    // Network error (e.g. socket hang up) — treat as inactive and try reconnect
    log.debug("IBKR", "[SessionMonitor] Health check error — attempting reconnect", { error: err?.message });

    if (wasSessionActive) {
      log.warn("IBKR", "[SessionMonitor] Health check failed (socket hang up?) — triggering auto-reconnect");
      wasSessionActive = false;
      alertSentForCurrentExpiry = false;
      consecutiveReconnectFails = 0;
    }

    // Attempt auto-reconnect on network error too
    const restored = await tryReconnect();
    if (restored) {
      wasSessionActive = true;
      alertSentForCurrentExpiry = false;
    }
  }
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export async function startIbkrSessionMonitor() {
  if (monitorTimer) return;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    log.warn("IBKR", "Telegram not configured — skipping IBKR session monitor");
    return;
  }

  log.info("IBKR", `Starting IBKR session monitor (60s interval, auto-reconnect enabled)`);
  setTimeout(runMonitorCycle, 30_000);
  monitorTimer = setInterval(runMonitorCycle, CHECK_INTERVAL_MS);
}

export function stopIbkrSessionMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    log.info("IBKR", "Session monitor stopped");
  }
}

/** Pause/resume stubs kept for API compatibility */
export async function pauseMonitorPush(): Promise<void> {
  log.info("IBKR", "Session monitor paused");
}
export async function resumeMonitorPush(): Promise<void> {
  log.info("IBKR", "Session monitor resumed");
}
export function isMonitorPushPausedFn(): boolean { return false; }
export function getMonitorState() {
  const { latencyMs, lastRequestAt } = getIbindLatency();
  return {
    reconnectInProgress,
    consecutiveReconnectFails,
    lastReconnectAt,
    wasSessionActive,
    ibindLatencyMs: latencyMs as number | null,
    ibindLastRequestAt: lastRequestAt as number | null,
  };
}

/** IBIND /health — seconds left in mobile SESSION-STEAL grace (0 = not in grace). */
export async function getBrokerageStealGraceRemainingSec(): Promise<number> {
  try {
    const { ok, body } = await ibindRequest("GET", "/health");
    if (!ok) return 0;
    const rem = Number((body as { brokerage_steal_grace_remaining_sec?: number })?.brokerage_steal_grace_remaining_sec ?? 0);
    return Number.isFinite(rem) && rem > 0 ? rem : 0;
  } catch {
    return 0;
  }
}

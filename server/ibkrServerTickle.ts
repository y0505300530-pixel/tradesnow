/**
 * ibkrServerTickle.ts
 *
 * Server-side IBKR keepalive + watchdog service.
 * Runs every 50 seconds from the Node.js server — independent of the browser.
 *
 * Behaviour:
 *   1. Every 50s: GET /ibeam/status from control server (port 6000)
 *   2. If authenticated → POST /ibkr/v1/api/tickle (keepalive, resets 5-min IBKR timeout)
 *   3. If not authenticated (but container running) → increment consecutive failure counter
 *      - After MAX_CONSECUTIVE_FAILURES (12 = 600s = 10 min) → POST /ibeam/restart
 *      - After restart → send Telegram alert asking user to complete 2FA
 *   4. If container is down → increment failure counter + send Telegram alert
 *      - After MAX_CONSECUTIVE_FAILURES consecutive DOWN detections → POST /ibeam/restart
 *   5. Tracks last tickle time and status for UI display
 *
 * Restart guard:
 *   12 consecutive failures required (= 600s ≈ 10 min of sustained failure).
 *   This prevents restart storms from transient authenticated=false blips during
 *   normal 30s maintenance ticks. 1-2 failed polls must NOT trigger a restart.
 *
 * Why 50 seconds?
 *   IBKR kills the brokerage session after 5 minutes (300s) of no tickle.
 *   Official recommendation: tickle every ~60s. We use 50s for safety margin.
 */

import http from "http";
import { sendTelegramMessage } from "./telegram";
import { log } from "./logger";
import { getSystemSetting, setSystemSetting } from "./db";

const CONTROL_HOST = "143.198.141.131";

/**
 * Returns true if current time is within active trading hours (Israel time UTC+3):
 * Monday–Thursday: 08:00–23:30 (covers TASE 10:00-17:30 + US 16:30-23:00)
 * Friday: 08:00–23:30 (TASE 10:00-14:30 + US 16:30-23:00)
 * Saturday and Sunday: always inactive.
 */
function isActiveHours(): boolean {
  const now = new Date();
  // Israel is UTC+3 (no DST adjustment needed for this purpose)
  const israelMs = now.getTime() + 3 * 60 * 60 * 1000;
  const israel = new Date(israelMs);
  const day = israel.getUTCDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const hour = israel.getUTCHours();
  const minute = israel.getUTCMinutes();
  const timeMinutes = hour * 60 + minute;

  // Sat (6) and Sun (0) — always inactive
  if (day === 0 || day === 6) return false;

  // Mon–Fri (1–5): active 08:00–23:30
  return timeMinutes >= 8 * 60 && timeMinutes < 23 * 60 + 30;
}

const CONTROL_PORT = 6000;
const TICKLE_INTERVAL_MS = 50_000;          // 50 seconds — IBKR kills session after 5 min
const MAX_CONSECUTIVE_FAILURES = 12;        // auto-restart after 12 consecutive failures ≈ 600s (prevents restart storms from transient blips)
const TELEGRAM_COOLDOWN_MS = 10 * 60_000;   // max 1 Telegram alert per 10 minutes
const RESTART_COOLDOWN_MS = 5 * 60_000;     // don't restart more than once per 5 minutes
const DB_KEY = "ibeam_push_paused";         // key in systemSettings table

let tickleTimer: ReturnType<typeof setInterval> | null = null;
let lastTickleAt: Date | null = null;
let lastStatus: "authenticated" | "unauthenticated" | "down" | "restarting" | "unknown" = "unknown";
let consecutiveFailures = 0;
let lastTelegramAt = 0;
let lastRestartAt = 0;
// When true: user intentionally stopped iBeam — suppress ALL Telegram alerts and auto-restart
// Persisted to DB so it survives server restarts.
let isPushPaused = false;

/** Load isPushPaused from DB on startup */
async function loadPushPausedFromDb(): Promise<void> {
  try {
    const val = await getSystemSetting(DB_KEY);
    isPushPaused = val === "true";
    log.info("IBKR", `[ServerTickle] Loaded isPushPaused from DB: ${isPushPaused}`);
  } catch (err: any) {
    log.warn("IBKR", `[ServerTickle] Could not load isPushPaused from DB (using default false): ${err.message}`);
    isPushPaused = false;
  }
}

/** Persist isPushPaused to DB */
async function savePushPausedToDb(value: boolean): Promise<void> {
  try {
    await setSystemSetting(DB_KEY, value ? "true" : "false");
  } catch (err: any) {
    log.warn("IBKR", `[ServerTickle] Could not save isPushPaused to DB: ${err.message}`);
  }
}

function controlRequest(method: "GET" | "POST", path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: CONTROL_HOST,
        port: CONTROL_PORT,
        path,
        method,
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
        });
      }
    );
    req.setTimeout(8_000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    if (method === "POST") req.write("{}");
    req.end();
  });
}

async function maybeSendTelegram(message: string): Promise<void> {
  if (isPushPaused) return; // user stopped iBeam intentionally — no alerts
  if (!isActiveHours()) return; // outside active hours (Sat/Sun or 23:30–08:00) — no alerts
  const now = Date.now();
  if (now - lastTelegramAt < TELEGRAM_COOLDOWN_MS) return;
  const sent = await sendTelegramMessage(message).catch(() => false);
  if (sent) lastTelegramAt = now;
}

/**
 * Attempt auto-restart of iBeam if cooldown allows.
 * Returns true if restart was attempted.
 */
async function maybeAutoRestart(reason: string): Promise<boolean> {
  if (isPushPaused) {
    log.info("IBKR", `[ServerTickle] Auto-restart suppressed — push is paused (user stopped iBeam intentionally)`);
    return false;
  }
  if (!isActiveHours()) {
    log.info("IBKR", `[ServerTickle] Auto-restart suppressed — outside active hours (Sat/Sun or 23:30–08:00 Israel)`);
    return false;
  }
  const now = Date.now();
  const canRestart = now - lastRestartAt > RESTART_COOLDOWN_MS;

  if (!canRestart) {
    const waitMin = Math.ceil((RESTART_COOLDOWN_MS - (now - lastRestartAt)) / 60_000);
    log.warn("IBKR", `[ServerTickle] Restart cooldown active — waiting ${waitMin}m`);
    return false;
  }

  log.warn("IBKR", `[ServerTickle] ${consecutiveFailures} consecutive failures (${reason}) — attempting auto-restart`);
  lastStatus = "restarting";
  lastRestartAt = now;
  consecutiveFailures = 0; // reset counter after restart attempt

  try {
    await controlRequest("POST", "/ibeam/restart");
    log.info("IBKR", `[ServerTickle] iBeam restart command sent`);

    await maybeSendTelegram(
      `🔄 <b>iBeam Auto-Restarted</b>\n\n` +
      `The server detected ${MAX_CONSECUTIVE_FAILURES} consecutive failures (${reason}) and restarted iBeam.\n\n` +
      `⚠️ <b>Action required:</b> Go to <b>trade-snow2.vip → Settings → IBKR</b> and complete 2FA authentication to restore trading.`
    );
    return true;
  } catch (restartErr: any) {
    log.error("IBKR", `[ServerTickle] Auto-restart failed`, { error: restartErr.message });
    await maybeSendTelegram(
      `⚠️ <b>iBeam Auto-Restart FAILED</b>\n\n` +
      `Could not restart iBeam automatically.\n` +
      `Please restart manually via <b>trade-snow2.vip → Settings → IBKR → Recreate iBeam Container</b>.`
    );
    return false;
  }
}

async function runTickle() {
  try {
    // Step 1: Check iBeam status via control server
    const status = await controlRequest("GET", "/ibeam/status") as any;

    // ── Container is completely down ──────────────────────────────────────────
    if (status?.error || status?.status === "exited" || status?.status === "stopped") {
      lastStatus = "down";
      consecutiveFailures++;
      log.warn("IBKR", `[ServerTickle] iBeam container is DOWN`, {
        status: status?.status,
        failures: consecutiveFailures,
      });

      // Send Telegram alert (with cooldown)
      await maybeSendTelegram(
        `🔴 <b>iBeam Container DOWN</b>\n\n` +
        `The IBKR Gateway container has stopped.\n` +
        `Status: <code>${status?.status ?? "unknown"}</code>\n` +
        `Consecutive failures: ${consecutiveFailures}\n\n` +
        `Auto-restart will trigger after ${MAX_CONSECUTIVE_FAILURES} failures. ` +
        `Or go to <b>trade-snow2.vip → Settings → IBKR</b> and click <b>Recreate iBeam Container</b>.`
      );

      // Auto-restart after MAX_CONSECUTIVE_FAILURES (same as unauthenticated)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await maybeAutoRestart("container DOWN");
      }
      return;
    }

    // ── Container running but NOT authenticated ───────────────────────────────
    if (!status?.authenticated) {
      consecutiveFailures++;
      lastStatus = "unauthenticated";
      log.warn("IBKR", `[ServerTickle] iBeam not authenticated`, {
        running: status?.status,
        failures: consecutiveFailures,
      });

      // Auto-restart after MAX_CONSECUTIVE_FAILURES
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await maybeAutoRestart("not authenticated");
      }
      return;
    }

    // ── Authenticated — send tickle ───────────────────────────────────────────
    await controlRequest("POST", "/ibkr/v1/api/tickle");
    lastTickleAt = new Date();
    lastStatus = "authenticated";

    // Reset failure counter on success
    if (consecutiveFailures > 0) {
      log.info("IBKR", `[ServerTickle] Session restored after ${consecutiveFailures} failures`);
      consecutiveFailures = 0;
    }

    log.debug("IBKR", `[ServerTickle] Tickle sent`, { at: lastTickleAt.toISOString() });

  } catch (err: any) {
    lastStatus = "down";
    consecutiveFailures++;
    log.warn("IBKR", `[ServerTickle] Request failed`, {
      error: err.message,
      failures: consecutiveFailures,
    });

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await maybeSendTelegram(
        `🔴 <b>iBeam Unreachable</b>\n\n` +
        `Cannot reach the IBKR Gateway (${consecutiveFailures} consecutive failures).\n` +
        `Error: <code>${err.message}</code>\n\n` +
        `Check the VPS and restart iBeam from <b>trade-snow2.vip → Settings → IBKR</b>.`
      );
    }
  }
}

export async function startServerTickle() {
  if (tickleTimer) return; // already running

  // Load persisted pause state from DB before starting
  await loadPushPausedFromDb();

  log.info("IBKR", `[ServerTickle] Starting server-side keepalive (every ${TICKLE_INTERVAL_MS / 1000}s, auto-restart after ${MAX_CONSECUTIVE_FAILURES} failures, pushPaused=${isPushPaused})`);

  // Run immediately on startup
  runTickle();

  // Then every 50 seconds
  tickleTimer = setInterval(runTickle, TICKLE_INTERVAL_MS);
}

export function stopServerTickle() {
  if (tickleTimer) {
    clearInterval(tickleTimer);
    tickleTimer = null;
    log.info("IBKR", `[ServerTickle] Stopped`);
  }
}

/** Pause all Telegram alerts and auto-restart (user intentionally stopped iBeam) */
export async function pauseTicklePush(): Promise<void> {
  isPushPaused = true;
  consecutiveFailures = 0; // reset so stale count doesn't trigger restart on resume
  await savePushPausedToDb(true);
  log.info("IBKR", `[ServerTickle] Push notifications PAUSED by user (persisted to DB)`);
}

/** Resume Telegram alerts and auto-restart */
export async function resumeTicklePush(): Promise<void> {
  isPushPaused = false;
  consecutiveFailures = 0;
  lastTelegramAt = 0; // allow immediate alert if needed
  await savePushPausedToDb(false);
  log.info("IBKR", `[ServerTickle] Push notifications RESUMED (persisted to DB)`);
}

/** Returns whether push is currently paused */
export function isTicklePushPaused(): boolean {
  return isPushPaused;
}

export function getServerTickleStatus() {
  return {
    running: tickleTimer !== null,
    lastTickleAt: lastTickleAt?.toISOString() ?? null,
    lastStatus,
    consecutiveFailures,
    intervalMs: TICKLE_INTERVAL_MS,
    pushPaused: isPushPaused,
  };
}

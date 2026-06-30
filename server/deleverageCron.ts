/**
 * Independent EOD deleverage scheduler — not tied to AlertPoller.
 * Runs every 60s, triggers runDeleveragingCycle once per day at 22:45 Israel time.
 */
import { getSystemSetting, setSystemSetting } from "./db";
import {
  runDeleveragingCycle,
  getLiveConfig,
  runCircuitBreakerTick,
} from "./liveOrderExecutor";
import { ELZA_V45_CFG } from "./engine/elzaV45Master";
import { sendTelegramMessage } from "./telegram";
import { log } from "./logger";

const SETTINGS_KEY = "lastDeleverageDate";
const OWNER_USER_ID = 1;

// CB-3 — NON-RE-ENTRANT cron tick. If a prior tick is still in flight (a slow IBKR read),
// skip this tick rather than running two circuit-breaker checks concurrently.
let _cbTickRunning = false;

function israelNow(): { hour: number; minute: number; dateKey: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  return { hour, minute, dateKey };
}

export function startDeleverageCron(): void {
  const tick = async () => {
    try {
      const { hour, minute, dateKey } = israelNow();
      const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      if (isWeekend) return; // markets closed all weekend — nothing to manage

      // ── CB-1/CB-2/CB-3 — LIVE-BROKER circuit-breaker (INERT unless flag=1) ───────
      // Runs every 60s tick. When elzaV45LiveEnabled=0 this whole block is skipped →
      // behavior byte-identical to today. When armed, runCircuitBreakerTick reads LIVE
      // NLV + day P&L DIRECTLY from IBKR (NOT the static config.totalNlv), derives the
      // day-open baseline (NLV_now − brokerDayPnl) without a first-tick seed, feeds the
      // PURE circuitBreaker the LIVE pct, and:
      //   • on a −MAX% day → flattens EXACTLY ONCE (idempotent persisted latch) + blocks entries
      //   • on a BAD/STALE read → ALERT MODE: block all entries, fire alert, NO flatten/baseline
      // CB-3 non-re-entrancy: skip if a prior tick is still in flight.
      if (_cbTickRunning) {
        log.warn("DELEVERAGE_CRON", `[CircuitBreaker] prior tick still running — skipping this tick (non-re-entrant)`);
      } else {
        _cbTickRunning = true;
        try {
          const cbConfig = await getLiveConfig(OWNER_USER_ID);
          const elzaArmed = ((cbConfig as any)?.elzaV45LiveEnabled ?? 0) === 1;
          if (elzaArmed) {
            const res = await runCircuitBreakerTick(OWNER_USER_ID);
            if (res.mode === "flattened") {
              log.error("DELEVERAGE_CRON", `[CircuitBreaker] FLATTEN-ALL fired — ${res.reason} (dayPnl ${((res.portfolioDayPnlPct ?? 0) * 100).toFixed(2)}%)`);
              await sendTelegramMessage(
                `🛑 *CIRCUIT BREAKER — FLATTEN ALL*\n` +
                `Day P&L ${((res.portfolioDayPnlPct ?? 0) * 100).toFixed(2)}% (NLV $${(res.nlvNow ?? 0).toFixed(0)} vs open $${(res.dayOpenNlv ?? 0).toFixed(0)})\n` +
                `Threshold −${(ELZA_V45_CFG.MAX_DAILY_LOSS_PCT * 100).toFixed(0)}%. All positions flattened; new entries blocked for the day.`
              ).catch(() => {});
            } else if (res.mode === "alert") {
              // runCircuitBreakerTick already fired the 🚨 Alert-Mode War-Room message.
              log.error("DELEVERAGE_CRON", `[CircuitBreaker] ALERT MODE — ${res.reason}. New entries blocked (no flatten).`);
            }
          }
        } catch (cbErr: any) {
          log.error("DELEVERAGE_CRON", `[CircuitBreaker] check error: ${cbErr?.message ?? cbErr}`);
        } finally {
          _cbTickRunning = false;
        }
      }

      // Window: 22:30–22:34 Israel (once per day, market days only)
      if (hour !== 22 || minute < 30 || minute > 34) return;

      const lastRun = await getSystemSetting(SETTINGS_KEY);
      if (lastRun === dateKey) return;

      await setSystemSetting(SETTINGS_KEY, dateKey);
      log.info("DELEVERAGE_CRON", `[Deleverage-EOD] 🔔 Independent cron triggered at ${dateKey} 22:${String(minute).padStart(2, "0")} IST`);

      const result = await runDeleveragingCycle(OWNER_USER_ID);
      const msg =
        `⚖️ *EOD Deleverage* (22:30)\n` +
        `Trimmed: ${result.trimmed} | Failed: ${result.failed}\n` +
        `UV: $${result.uvBeforeUsd.toFixed(0)} → $${result.uvAfterUsd.toFixed(0)}`;
      await sendTelegramMessage(msg).catch(() => {});
    } catch (e: any) {
      log.error("DELEVERAGE_CRON", `Deleverage cron error: ${e?.message ?? e}`);
    }
  };

  setInterval(() => { tick().catch(() => {}); }, 60_000);
  tick().catch(() => {});
  console.log("[DeleverageCron] Started — checks every 60s for 22:30 IST window (weekdays only)");
}

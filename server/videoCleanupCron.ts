/**
 * Monthly video cleanup — 1st of each month at 03:00 Israel time.
 * Removes channel videos + analyses older than 20 days.
 */
import { getSystemSetting, setSystemSetting } from "./db";
import { log } from "./logger";
import { sendTelegramMessage } from "./telegram";
import { runVideoCleanup, VIDEO_CLEANUP_DEFAULT_DAYS } from "./videoCleanup";

const SETTINGS_KEY = "lastVideoCleanupMonth";

function israelNow(): { day: number; hour: number; minute: number; monthKey: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const day = parseInt(get("day"), 10);
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const monthKey = `${get("year")}-${get("month")}`;
  return { day, hour, minute, monthKey };
}

export function startVideoCleanupCron(): void {
  const tick = async () => {
    try {
      const { day, hour, minute, monthKey } = israelNow();
      // 1st of month, 03:00–03:14 IST — once per calendar month
      if (day !== 1 || hour !== 3 || minute > 14) return;

      const lastRun = await getSystemSetting(SETTINGS_KEY);
      if (lastRun === monthKey) return;

      await setSystemSetting(SETTINGS_KEY, monthKey);
      log.info("VIDEO_CLEANUP_CRON", `Monthly cleanup starting (${monthKey}, >${VIDEO_CLEANUP_DEFAULT_DAYS}d)`);

      const result = await runVideoCleanup({ days: VIDEO_CLEANUP_DEFAULT_DAYS });
      const msg =
        `🧹 <b>Video Cleanup</b> (${monthKey})\n` +
        `Videos: ${result.channelVideos} | Analyses: ${result.analysesOld}\n` +
        `Linked removed: ${result.analysesLinked}`;
      await sendTelegramMessage(msg).catch(() => {});
    } catch (e: unknown) {
      log.error("VIDEO_CLEANUP_CRON", `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  setInterval(() => { tick().catch(() => {}); }, 60_000);
  tick().catch(() => {});
  console.log("[VideoCleanupCron] Started — 1st of month 03:00 IST, videos older than 20 days");
}

/**
 * Recover live positions stuck in zombie status after repeated exit failures.
 * After MAX_ZOMBIE_RETRIES → force close via Marketable LMT (Iron Rule 3).
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "./db";
import { livePositions } from "../drizzle/schema";
import { executeLiveSell } from "./liveOrderExecutor";
import { sendTelegramMessage } from "./telegram";
import { log } from "./logger";

const MAX_ZOMBIE_RETRIES = 3;
const OWNER_USER_ID = 1;

export async function runZombieRecoveryCycle(): Promise<{ attempted: number; closed: number }> {
  const db = await getDb();
  if (!db) return { attempted: 0, closed: 0 };

  const zombies = await db
    .select()
    .from(livePositions)
    .where(
      and(
        eq(livePositions.userId, OWNER_USER_ID),
        eq(livePositions.status, "zombie"),
        gte(livePositions.exitRetryCount, MAX_ZOMBIE_RETRIES),
      ),
    );

  let attempted = 0;
  let closed = 0;

  for (const pos of zombies) {
    attempted++;
    log.warn("ZOMBIE_RECOVERY", `[${pos.ticker}] exitRetryCount=${pos.exitRetryCount} — forcing Marketable LMT close`);
    try {
      const result = await executeLiveSell({
        userId: OWNER_USER_ID,
        positionId: pos.id,
        reason: "zombie_hard_close",
      });
      if (result.success) {
        closed++;
        await sendTelegramMessage(
          `🚨 *FORCED EXIT* ${pos.ticker}\n` +
          `Zombie after ${pos.exitRetryCount} failures → hard close OK\n` +
          `${result.reason}`,
        ).catch(() => {});
      } else {
        await sendTelegramMessage(
          `🚨🚨 *FORCED EXIT FAILED* ${pos.ticker}\n` +
          `Retries: ${pos.exitRetryCount} | ${result.reason}\n` +
          `⚠️ Manual intervention required`,
        ).catch(() => {});
      }
    } catch (e: any) {
      log.error("ZOMBIE_RECOVERY", `[${pos.ticker}] hard close exception: ${e?.message ?? e}`);
    }
  }

  return { attempted, closed };
}

export function startZombieRecoveryMonitor(): void {
  const tick = () => runZombieRecoveryCycle().catch((e) => {
    log.error("ZOMBIE_RECOVERY", `Cycle error: ${e?.message ?? e}`);
  });
  setInterval(tick, 5 * 60_000);
  setTimeout(tick, 30_000);
  console.log("[ZombieRecovery] Started — checks every 5 min for zombie positions (≥3 retries)");
}

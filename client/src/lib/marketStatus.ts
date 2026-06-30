/**
 * Client-side market status helpers.
 * Used to determine if TASE/NYSE is closed for UI display.
 *
 * Market hours (all times in ET for US, Israel time for TASE):
 *   NYSE/NASDAQ RTH:  09:30–16:00 ET  (Mon–Fri)
 *   US Pre-market:    04:00–09:30 ET  (Mon–Fri)
 *   US After-hours:   16:00–20:00 ET  (Mon–Fri)
 *   TASE RTH:         09:00–17:30 IL  (Mon–Fri)
 *   Crypto:           24/7
 */

// ── TASE Holidays ─────────────────────────────────────────────────────────────
const TASE_HOLIDAYS: Set<string> = new Set([
  // 2025
  '2025-01-29', '2025-03-13', '2025-04-13', '2025-04-14', '2025-04-15',
  '2025-04-16', '2025-04-17', '2025-04-18', '2025-04-20', '2025-04-21',
  '2025-05-01', '2025-05-02', '2025-06-01', '2025-06-02',
  '2025-09-22', '2025-09-23', '2025-09-24', '2025-10-01', '2025-10-02',
  '2025-10-06', '2025-10-07', '2025-10-13', '2025-10-14', '2025-10-15',
  // 2026
  '2026-03-03', '2026-04-01', '2026-04-02', '2026-04-08', '2026-04-09',
  '2026-04-22', '2026-04-23', '2026-05-21', '2026-05-22',
  '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-19', '2026-09-20',
  '2026-09-24', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-03',
  // 2027
  '2027-03-23', '2027-04-20', '2027-04-21', '2027-04-22', '2027-04-23',
  '2027-04-24', '2027-04-25', '2027-04-27', '2027-05-12', '2027-05-13',
  '2027-06-10', '2027-06-11', '2027-09-01', '2027-09-02', '2027-09-03',
  '2027-09-10', '2027-09-11', '2027-09-15', '2027-09-16', '2027-09-22',
  '2027-09-23', '2027-09-24',
]);

// ── US Holidays (NYSE closed) ─────────────────────────────────────────────────
// Includes observed dates when holiday falls on weekend
const US_HOLIDAYS: Set<string> = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function toIsraelDateString(now: Date = new Date()): string {
  const ilMs = now.getTime() + 3 * 3600 * 1000;
  const il = new Date(ilMs);
  const y = il.getUTCFullYear();
  const m = String(il.getUTCMonth() + 1).padStart(2, '0');
  const d = String(il.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Get current ET (Eastern Time) offset from UTC: -4 in DST (Mar-Nov), -5 in winter */
function getEtOffsetHours(now: Date = new Date()): number {
  const month = now.getUTCMonth(); // 0-indexed
  // DST: second Sunday of March to first Sunday of November
  // Simplified: March (2) through October (9) = -4, else -5
  return (month >= 2 && month <= 10) ? 4 : 5;
}

/** Convert UTC date to ET date string (YYYY-MM-DD) */
function toEtDateString(now: Date = new Date()): string {
  const offset = getEtOffsetHours(now);
  const etMs = now.getTime() - offset * 3600 * 1000;
  const et = new Date(etMs);
  const y = et.getUTCFullYear();
  const m = String(et.getUTCMonth() + 1).padStart(2, '0');
  const d = String(et.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Get current time in ET as { day, hour, minute } */
function getEtTime(now: Date = new Date()): { day: number; hour: number; minute: number; minutes: number } {
  const offset = getEtOffsetHours(now);
  const etMs = now.getTime() - offset * 3600 * 1000;
  const et = new Date(etMs);
  const day = et.getUTCDay(); // 0=Sun, 6=Sat
  const hour = et.getUTCHours();
  const minute = et.getUTCMinutes();
  return { day, hour, minute, minutes: hour * 60 + minute };
}

// ── Exported Market Status Functions ──────────────────────────────────────────

/** Returns true if TASE is not trading today (holiday or weekend Sat/Sun) */
export function isTaseClosedToday(now: Date = new Date()): boolean {
  const ilDay = new Date(now.getTime() + 3 * 3600 * 1000).getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  // TASE switched to Mon-Fri schedule in Oct 2023. Closed on Sat(6) + Sun(0).
  if (ilDay === 0 || ilDay === 6) return true;
  return TASE_HOLIDAYS.has(toIsraelDateString(now));
}

/**
 * Returns true if US market (NYSE/NASDAQ) is NOT currently in any trading session.
 * "Not trading" means: weekend, US holiday, or outside extended hours (before 04:00 ET or after 20:00 ET).
 *
 * When this returns true → Today% for US tickers should be 0 (no stale Friday data).
 * When this returns false → US market is in pre-market, RTH, or after-hours → show live change.
 */
export function isUsMarketClosedNow(now: Date = new Date()): boolean {
  const et = getEtTime(now);

  // Weekend: Saturday or Sunday — no trading at all
  if (et.day === 0 || et.day === 6) return true;

  // US Holiday
  if (US_HOLIDAYS.has(toEtDateString(now))) return true;

  // Weekday but outside extended hours (04:00–20:00 ET)
  // Pre-market starts at 04:00 ET, after-hours ends at 20:00 ET
  if (et.minutes < 4 * 60 || et.minutes >= 20 * 60) return true;

  return false;
}

/**
 * Returns true only when US market is closed due to weekend or holiday.
 * Returns false on weekdays (even outside trading hours).
 * Use this to distinguish "no trading today at all" from "trading day but outside hours".
 */
export function isUsWeekendOrHoliday(now: Date = new Date()): boolean {
  const et = getEtTime(now);
  if (et.day === 0 || et.day === 6) return true;
  if (US_HOLIDAYS.has(toEtDateString(now))) return true;
  return false;
}

/**
 * Returns the current US market session state.
 * Useful for UI indicators.
 */
export type UsMarketState = 'closed' | 'pre_market' | 'open' | 'after_hours';

export function getUsMarketState(now: Date = new Date()): UsMarketState {
  const et = getEtTime(now);

  // Weekend or holiday
  if (et.day === 0 || et.day === 6) return 'closed';
  if (US_HOLIDAYS.has(toEtDateString(now))) return 'closed';

  // Before pre-market (00:00–04:00 ET)
  if (et.minutes < 4 * 60) return 'closed';

  // Pre-market (04:00–09:30 ET)
  if (et.minutes < 9 * 60 + 30) return 'pre_market';

  // RTH (09:30–16:00 ET)
  if (et.minutes < 16 * 60) return 'open';

  // After-hours (16:00–20:00 ET)
  if (et.minutes < 20 * 60) return 'after_hours';

  // After 20:00 ET
  return 'closed';
}

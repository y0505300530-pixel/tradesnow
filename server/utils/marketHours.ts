/**
 * marketHours.ts — Per-exchange market state utilities
 *
 * Rules:
 *  - US (NASDAQ/NYSE): Mon–Fri 09:30–16:00 ET, pre-market 04:00–09:30 ET
 *    Half-days: closes at 13:00 ET (day before Thanksgiving, Christmas Eve)
 *  - TASE: Mon–Fri 09:30–17:30 Israel time (UTC+3), closed Sat–Sun
 *    (TASE switched from Sun–Thu to Mon–Fri schedule in October 2023)
 *  - ET offset: UTC-5 (Nov–Mar) / UTC-4 (Mar–Nov)
 *  - Israel offset: UTC+3 year-round (no DST adjustment needed here)
 *  - Both exchanges observe their respective holiday calendars
 */

export type ExchangeType = 'US' | 'TASE' | 'UNKNOWN';

/** Detect exchange from ticker symbol or currency */
export function getExchange(ticker: string, currency?: string): ExchangeType {
  if (currency?.toUpperCase() === 'ILS') return 'TASE';
  if (ticker.endsWith('.TA')) return 'TASE';
  return 'US';
}

// ── Holiday Calendars ──────────────────────────────────────────────────────

/**
 * NYSE full holidays 2025–2027 (YYYY-MM-DD in ET local date)
 * Source: NYSE holiday schedule
 */
const NYSE_HOLIDAYS: Set<string> = new Set([
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents' Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Day
  '2027-02-15', // Presidents' Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, June 19 is Saturday)
  '2027-07-05', // Independence Day (observed, July 4 is Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed, Dec 25 is Saturday)
]);

/**
 * NYSE half-days: market closes early at 13:00 ET (YYYY-MM-DD in ET local date)
 * Typically: day before Thanksgiving (Wed) + Christmas Eve (Dec 24) when it's a weekday
 */
const NYSE_HALF_DAYS: Set<string> = new Set([
  // 2025
  '2025-07-03', // Day before Independence Day (Thursday, market closes 13:00 ET)
  '2025-11-28', // Day after Thanksgiving (Black Friday, closes 13:00 ET)
  '2025-12-24', // Christmas Eve (Wednesday)
  // 2026
  '2026-11-27', // Day after Thanksgiving (Black Friday)
  // Christmas Eve 2026 = Thursday Dec 24 — but Dec 25 is Friday (holiday), so Dec 24 is a half-day
  '2026-12-24', // Christmas Eve (Thursday)
  // 2027
  '2027-11-26', // Day after Thanksgiving (Black Friday)
  // Christmas Eve 2027 = Friday Dec 24 — Dec 25 is Saturday, observed Dec 24 is full holiday (already in NYSE_HOLIDAYS)
  // So no Christmas Eve half-day for 2027
]);

/**
 * TASE holidays 2025–2027 (YYYY-MM-DD in Israel local date)
 * Source: TASE official calendar (Jewish holidays + Israeli national holidays)
 */
const TASE_HOLIDAYS: Set<string> = new Set([
  // 2025
  '2025-01-29', // Tu BiShvat (half day — treated as closed for simplicity)
  '2025-03-13', // Purim
  '2025-04-13', // Passover Eve (half day)
  '2025-04-14', // Passover I
  '2025-04-15', // Passover II (Chol HaMoed)
  '2025-04-16', // Passover III (Chol HaMoed)
  '2025-04-17', // Passover IV (Chol HaMoed)
  '2025-04-18', // Passover V (Chol HaMoed)
  '2025-04-20', // Passover VII (last day)
  '2025-04-21', // Passover VIII (last day — diaspora, TASE closed)
  '2025-05-01', // Independence Day Eve
  '2025-05-02', // Independence Day (Yom HaAtzmaut)
  '2025-06-01', // Shavuot Eve
  '2025-06-02', // Shavuot
  '2025-09-22', // Rosh Hashana Eve
  '2025-09-23', // Rosh Hashana I
  '2025-09-24', // Rosh Hashana II
  '2025-10-01', // Yom Kippur Eve
  '2025-10-02', // Yom Kippur
  '2025-10-06', // Sukkot Eve
  '2025-10-07', // Sukkot I
  '2025-10-13', // Hoshana Raba (half day)
  '2025-10-14', // Shemini Atzeret / Simchat Torah Eve
  '2025-10-15', // Shemini Atzeret / Simchat Torah
  // 2026
  '2026-03-03', // Purim
  '2026-04-01', // Passover Eve
  '2026-04-02', // Passover I
  '2026-04-08', // Passover VII
  '2026-04-09', // Passover VIII
  '2026-04-22', // Independence Day Eve
  '2026-04-23', // Independence Day (Yom HaAtzmaut)
  '2026-05-21', // Shavuot Eve
  '2026-05-22', // Shavuot
  '2026-09-10', // Rosh Hashana Eve
  '2026-09-11', // Rosh Hashana I
  '2026-09-12', // Rosh Hashana II
  '2026-09-19', // Yom Kippur Eve
  '2026-09-20', // Yom Kippur
  '2026-09-24', // Sukkot Eve
  '2026-09-25', // Sukkot I
  '2026-10-01', // Hoshana Raba
  '2026-10-02', // Shemini Atzeret Eve
  '2026-10-03', // Shemini Atzeret / Simchat Torah
  // 2027
  '2027-03-23', // Purim
  '2027-04-20', // Passover Eve
  '2027-04-21', // Passover I
  '2027-04-22', // Passover II (Chol HaMoed)
  '2027-04-23', // Passover III (Chol HaMoed)
  '2027-04-24', // Passover IV (Chol HaMoed)
  '2027-04-25', // Passover V (Chol HaMoed)
  '2027-04-27', // Passover VII (last day)
  '2027-05-12', // Independence Day Eve
  '2027-05-13', // Independence Day (Yom HaAtzmaut)
  '2027-06-10', // Shavuot Eve
  '2027-06-11', // Shavuot
  '2027-09-01', // Rosh Hashana Eve
  '2027-09-02', // Rosh Hashana I
  '2027-09-03', // Rosh Hashana II
  '2027-09-10', // Yom Kippur Eve
  '2027-09-11', // Yom Kippur
  '2027-09-15', // Sukkot Eve
  '2027-09-16', // Sukkot I
  '2027-09-22', // Hoshana Raba
  '2027-09-23', // Shemini Atzeret / Simchat Torah Eve
  '2027-09-24', // Shemini Atzeret / Simchat Torah
]);

/** Format a Date as YYYY-MM-DD in ET timezone */
function toEtDateString(now: Date): string {
  const offset = etOffsetHours(now);
  const etMs = now.getTime() - offset * 3600 * 1000;
  const et = new Date(etMs);
  const y = et.getUTCFullYear();
  const m = String(et.getUTCMonth() + 1).padStart(2, '0');
  const d = String(et.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Format a Date as YYYY-MM-DD in Israel timezone (UTC+3) */
function toIsraelDateString(now: Date): string {
  const ilMs = now.getTime() + 3 * 3600 * 1000;
  const il = new Date(ilMs);
  const y = il.getUTCFullYear();
  const m = String(il.getUTCMonth() + 1).padStart(2, '0');
  const d = String(il.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Is today a NYSE full holiday? */
export function isNyseHoliday(now: Date = new Date()): boolean {
  return NYSE_HOLIDAYS.has(toEtDateString(now));
}

/** Is today a NYSE half-day (early close at 13:00 ET)? */
export function isNyseHalfDay(now: Date = new Date()): boolean {
  return NYSE_HALF_DAYS.has(toEtDateString(now));
}

/** Is today a TASE holiday? */
export function isTaseHoliday(now: Date = new Date()): boolean {
  return TASE_HOLIDAYS.has(toIsraelDateString(now));
}

// ── DST helpers ────────────────────────────────────────────────────────────

/** Get current ET offset in hours (positive = subtract from UTC to get ET) */
function etOffsetHours(now: Date): number {
  // DST: second Sunday of March → first Sunday of November
  const year = now.getUTCFullYear();
  const dstStart = nthSundayOfMonth(year, 2, 2); // Second Sunday of March
  const dstEnd = nthSundayOfMonth(year, 10, 1);  // First Sunday of November
  const ts = now.getTime();
  if (ts >= dstStart && ts < dstEnd) return 4; // EDT = UTC-4
  return 5; // EST = UTC-5
}

function nthSundayOfMonth(year: number, month: number, nth: number): number {
  // month: 0-indexed (0=Jan, 2=Mar, 10=Nov)
  const d = new Date(Date.UTC(year, month, 1));
  const firstSunday = (7 - d.getUTCDay()) % 7;
  const day = firstSunday + (nth - 1) * 7 + 1;
  return Date.UTC(year, month, day, 7, 0, 0);
}

/** Get current ET time components */
export function getEtTime(now: Date): { day: number; hour: number; minute: number; totalMinutes: number } {
  const offset = etOffsetHours(now);
  const etMs = now.getTime() - offset * 3600 * 1000;
  const et = new Date(etMs);
  const day = et.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const hour = et.getUTCHours();
  const minute = et.getUTCMinutes();
  return { day, hour, minute, totalMinutes: hour * 60 + minute };
}

/** Get current Israel time components */
function getIsraelTime(now: Date): { day: number; hour: number; minute: number; totalMinutes: number } {
  const ilMs = now.getTime() + 3 * 3600 * 1000;
  const il = new Date(ilMs);
  const day = il.getUTCDay();
  const hour = il.getUTCHours();
  const minute = il.getUTCMinutes();
  return { day, hour, minute, totalMinutes: hour * 60 + minute };
}

// ── US Market ──────────────────────────────────────────────────────────────

/** Is US regular session open? Mon–Fri 09:30–16:00 ET (or 09:30–13:00 on half-days), excluding NYSE holidays */
export function isUsOpen(now: Date = new Date()): boolean {
  if (isNyseHoliday(now)) return false;
  const { day, totalMinutes } = getEtTime(now);
  if (day === 0 || day === 6) return false; // Sun/Sat
  const closeTime = isNyseHalfDay(now) ? 13 * 60 : 16 * 60; // 13:00 on half-days
  return totalMinutes >= 9 * 60 + 30 && totalMinutes < closeTime;
}

/** Is US pre-market session active? Mon–Fri 04:00–09:30 ET, excluding NYSE holidays */
export function isPreMarketUs(now: Date = new Date()): boolean {
  if (isNyseHoliday(now)) return false;
  const { day, totalMinutes } = getEtTime(now);
  if (day === 0 || day === 6) return false;
  return totalMinutes >= 4 * 60 && totalMinutes < 9 * 60 + 30;
}

/** Is US after-hours session active? Mon–Fri 16:00–20:00 ET (or 13:00–20:00 on half-days), excluding NYSE holidays */
export function isAfterHoursUs(now: Date = new Date()): boolean {
  if (isNyseHoliday(now)) return false;
  const { day, totalMinutes } = getEtTime(now);
  if (day === 0 || day === 6) return false;
  const afterStart = isNyseHalfDay(now) ? 13 * 60 : 16 * 60;
  return totalMinutes >= afterStart && totalMinutes < 20 * 60;
}

/** Is US market in any extended-hours session (pre or after)? */
export function isUsExtendedHours(now: Date = new Date()): boolean {
  return isPreMarketUs(now) || isAfterHoursUs(now);
}

/** Is US market completely closed (weekend, holiday, or outside all sessions)? */
export function isUsClosed(now: Date = new Date()): boolean {
  return !isUsOpen(now) && !isUsExtendedHours(now);
}

/** Is today a NYSE half-day (early close)? Alias for UI use. */
export function isUsHalfDay(now: Date = new Date()): boolean {
  return isNyseHalfDay(now) && !isNyseHoliday(now);
}

// ── TASE Market ────────────────────────────────────────────────────────────

/** Is TASE regular session open? Mon–Thu 10:00–17:30, Fri 10:00–14:30 Israel time, excluding TASE holidays
 *  Note: TASE switched from Sun–Thu to Mon–Fri schedule in October 2023. */
export function isTaseOpen(now: Date = new Date()): boolean {
  if (isTaseHoliday(now)) return false;
  const { day, totalMinutes } = getIsraelTime(now);
  // TASE: Mon(1)–Fri(5), closed Sat(6)–Sun(0)
  if (day === 0 || day === 6) return false;
  const open = 10 * 60; // 10:00
  const close = day === 5 ? 14 * 60 + 30 : 17 * 60 + 30; // Fri 14:30, Mon-Thu 17:30
  return totalMinutes >= open && totalMinutes < close;
}

/** Is TASE pre-opening (09:30–10:00 Israel)? Mon–Fri only. */
export function isTasePreOpen(now: Date = new Date()): boolean {
  if (isTaseHoliday(now)) return false;
  const { day, totalMinutes } = getIsraelTime(now);
  // TASE: Mon(1)–Fri(5), closed Sat(6)–Sun(0)
  if (day === 0 || day === 6) return false;
  return totalMinutes >= 9 * 60 + 30 && totalMinutes < 10 * 60;
}

/** Is TASE closed (Fri, Sat, holiday, or outside hours)? */
export function isTaseClosed(now: Date = new Date()): boolean {
  return !isTaseOpen(now) && !isTasePreOpen(now);
}

/**
 * True when TASE does not trade **at all today** (Sat/Sun or TASE holiday).
 * NOT true on weekday evenings after 17:30 — session results must still display.
 * Mirrors client `isTaseClosedToday()` in `client/src/lib/marketStatus.ts`.
 */
export function isTaseClosedToday(now: Date = new Date()): boolean {
  const { day } = getIsraelTime(now);
  if (day === 0 || day === 6) return true;
  return isTaseHoliday(now);
}

/** IBKR sync / live SL enforcement — run when either US or TASE regular session is open */
export function isIbkrSyncMarketOpen(now: Date = new Date()): boolean {
  return isUsOpen(now) || isTaseOpen(now);
}

// ── Generic per-ticker helpers ─────────────────────────────────────────────

export interface MarketState {
  exchange: ExchangeType;
  isOpen: boolean;
  isPreMarket: boolean;
  isAfterHours: boolean;
  isClosed: boolean;
  isHoliday: boolean;
  isHalfDay: boolean;
  /** Label for display/logging */
  label: 'OPEN' | 'PRE_MARKET' | 'AFTER_HOURS' | 'CLOSED' | 'HOLIDAY' | 'HALF_DAY';
}

export function getMarketState(ticker: string, currency?: string, now: Date = new Date()): MarketState {
  const exchange = getExchange(ticker, currency);

  if (exchange === 'TASE') {
    const holiday = isTaseHoliday(now);
    const open = isTaseOpen(now);
    const pre = isTasePreOpen(now);
    const closed = !open && !pre;
    return {
      exchange,
      isOpen: open,
      isPreMarket: pre,
      isAfterHours: false,
      isClosed: closed,
      isHoliday: holiday,
      isHalfDay: false, // TASE doesn't have official half-days in this calendar
      label: holiday ? 'HOLIDAY' : open ? 'OPEN' : pre ? 'PRE_MARKET' : 'CLOSED',
    };
  }

  // US
  const holiday = isNyseHoliday(now);
  const halfDay = isUsHalfDay(now);
  const open = isUsOpen(now);
  const pre = isPreMarketUs(now);
  const after = isAfterHoursUs(now);
  const closed = !open && !pre && !after;
  return {
    exchange,
    isOpen: open,
    isPreMarket: pre,
    isAfterHours: after,
    isClosed: closed,
    isHoliday: holiday,
    isHalfDay: halfDay,
    label: holiday ? 'HOLIDAY' : halfDay && open ? 'HALF_DAY' : open ? 'OPEN' : pre ? 'PRE_MARKET' : after ? 'AFTER_HOURS' : 'CLOSED',
  };
}

// ── Next Market Open helper (v14.03) ─────────────────────────────────────────
/**
 * Returns the next time either US or TASE market opens.
 * Looks up to 7 days ahead. Returns ISO string or null if not found.
 */
export function getNextMarketOpen(now: Date = new Date()): { market: 'US' | 'TASE'; opensAt: string } | null {
  // Check next 7 days in 15-minute increments
  const MS_15MIN = 15 * 60 * 1000;
  const MAX_LOOKAHEAD = 7 * 24 * 60 * 60 * 1000; // 7 days

  let nextUs: Date | null = null;
  let nextTase: Date | null = null;

  // Find next US open
  let t = new Date(now.getTime() + MS_15MIN);
  while (t.getTime() - now.getTime() < MAX_LOOKAHEAD) {
    if (isUsOpen(t)) {
      // Walk back to find exact open time (09:30 ET on that day)
      const offset = t.getTimezoneOffset(); // not used, we use etOffsetHours logic
      // Find the start of that trading day
      const etOffset = etOffsetHours(t);
      const etMs = t.getTime() - etOffset * 3600 * 1000;
      const etDate = new Date(etMs);
      // Set to 09:30 ET on that day
      const openMs = Date.UTC(etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(), 9, 30, 0) + etOffset * 3600 * 1000;
      nextUs = new Date(openMs);
      if (nextUs.getTime() <= now.getTime()) nextUs = null; // already past
      break;
    }
    t = new Date(t.getTime() + MS_15MIN);
  }

  // Find next TASE open
  t = new Date(now.getTime() + MS_15MIN);
  while (t.getTime() - now.getTime() < MAX_LOOKAHEAD) {
    if (isTaseOpen(t)) {
      // Walk back to find exact open time (09:30 Israel on that day)
      const ilMs = t.getTime() + 3 * 3600 * 1000;
      const ilDate = new Date(ilMs);
      // Set to 09:30 Israel on that day
      const openMs = Date.UTC(ilDate.getUTCFullYear(), ilDate.getUTCMonth(), ilDate.getUTCDate(), 9, 30, 0) - 3 * 3600 * 1000;
      nextTase = new Date(openMs);
      if (nextTase.getTime() <= now.getTime()) nextTase = null; // already past
      break;
    }
    t = new Date(t.getTime() + MS_15MIN);
  }

  // Return the earlier one
  if (!nextUs && !nextTase) return null;
  if (!nextUs) return { market: 'TASE', opensAt: nextTase!.toISOString() };
  if (!nextTase) return { market: 'US', opensAt: nextUs.toISOString() };
  return nextUs.getTime() <= nextTase.getTime()
    ? { market: 'US', opensAt: nextUs.toISOString() }
    : { market: 'TASE', opensAt: nextTase.toISOString() };
}


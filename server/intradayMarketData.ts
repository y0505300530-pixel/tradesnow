/**
 * Intraday OHLCV fetch for backtest harnesses (Yahoo Finance chart API).
 *
 * Daily cache (priceCache / fetchBarsForTicker) is DAILY-only — this module is
 * the separate path for 15m / 60m bars used by elzaV3IntradayHarness.
 *
 * Yahoo limits (approx):
 *   15m — ~60 calendar days per request → auto-chunked
 *   60m — ~730 calendar days per request
 */
import type { Bar } from "./zivEngine";

export type IntradayInterval = "5m" | "15m" | "60m";

/** Bar with session date + intraday timestamp (America/New_York wall clock). */
export interface IntradayBar extends Bar {
  /** YYYY-MM-DD (NYSE session date) */
  date: string;
  /** HH:mm ET */
  time: string;
  /** ISO datetime YYYY-MM-DDTHH:mm:00 */
  datetime: string;
  ts: number;
}

const YAHOO_INTERVAL: Record<IntradayInterval, string> = {
  "5m": "5m",
  "15m": "15m",
  "60m": "60m",
};

/** Max chunk size in calendar days per Yahoo request. */
const CHUNK_DAYS: Record<IntradayInterval, number> = {
  "5m": 55,   // Yahoo serves ~60 calendar days of 5m bars — used by the armed-watcher confirm step.
  "15m": 55,
  "60m": 700,
};

function nyParts(tsSec: number): { date: string; time: string; datetime: string } {
  const d = new Date(tsSec * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}`;
  return { date, time, datetime: `${date}T${time}:00` };
}

function parseYahooChart(result: unknown, ticker: string): IntradayBar[] {
  const r = result as {
    timestamp?: number[];
    indicators?: { quote?: { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }[] };
  };
  const timestamps: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const out: IntradayBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = q.close?.[i];
    if (close == null || close <= 0) continue;
    const { date, time, datetime } = nyParts(timestamps[i]);
    out.push({
      date,
      time,
      datetime,
      ts: timestamps[i] * 1000,
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  if (ticker.endsWith(".TA") && out.length > 0) {
    for (const b of out) {
      b.open /= 100; b.high /= 100; b.low /= 100; b.close /= 100;
    }
  }
  return out;
}

async function fetchChunk(
  ticker: string,
  interval: IntradayInterval,
  period1: number,
  period2: number,
): Promise<IntradayBar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=${YAHOO_INTERVAL[interval]}&period1=${period1}&period2=${period2}&includePrePost=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  return parseYahooChart(result, ticker);
}

/**
 * Fetch intraday bars for [startDate, endDate] (inclusive calendar bounds).
 * Dedupes by datetime, sorted ascending.
 */
export async function fetchIntradayBarsForTicker(
  ticker: string,
  interval: IntradayInterval,
  startDate: string,
  endDate: string,
): Promise<IntradayBar[]> {
  const start = new Date(`${startDate}T00:00:00Z`).getTime() / 1000;
  const end = new Date(`${endDate}T23:59:59Z`).getTime() / 1000;
  const chunkSec = CHUNK_DAYS[interval] * 86400;
  const all: IntradayBar[] = [];
  let cursor = start;

  while (cursor < end) {
    const chunkEnd = Math.min(end, cursor + chunkSec);
    const bars = await fetchChunk(ticker, interval, cursor, chunkEnd);
    all.push(...bars);
    cursor = chunkEnd + 1;
    if (cursor < end) await new Promise(r => setTimeout(r, 250));
  }

  const seen = new Set<string>();
  return all
    .filter(b => b.date >= startDate.slice(0, 10) && b.date <= endDate.slice(0, 10))
    .filter(b => (seen.has(b.datetime) ? false : (seen.add(b.datetime), true)))
    .sort((a, b) => a.ts - b.ts);
}

/** Count unique NYSE session dates between two bar indices (inclusive end). */
export function sessionDaysBetween(bars: IntradayBar[], fromIdx: number, toIdx: number): number {
  const days = new Set<string>();
  for (let i = fromIdx; i <= toIdx && i < bars.length; i++) days.add(bars[i].date);
  return days.size;
}

/** Regular-session bars only (09:30–16:00 ET). */
export function filterRegularSession(bars: IntradayBar[]): IntradayBar[] {
  return bars.filter(b => {
    const [h, m] = b.time.split(":").map(Number);
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins <= 16 * 60;
  });
}

// server/tradingJournal.ts
// A5 — Daily trading journal → Telegram at 23:10 Israel time.
// "Trader's notebook", NOT an ops/incident log: what we traded, why we exited, and whether it was a
// good call. Built from EXISTING tables (livePositions) so it ships without the richer
// engineDecisionLog (a later upgrade). Hybrid: deterministic facts + one rule-derived insight.
// Format reference: Base44 prototype (trading_journal_telegram_23-10).
//
// DATA INTEGRITY (ties to A1): closes with exitReason CLOSED_IBKR_NO_PRICE have a FABRICATED $0 P&L
// (real value unknown) and ENTRY_CANCELLED rows are no-fill phantoms — BOTH are excluded from the
// realized total and win-rate, and the no-price ones are surfaced as a caveat so the number is honest.
import { getDb } from "./db";
import { livePositions } from "../drizzle/schema";
import { and, eq, gte, inArray, desc } from "drizzle-orm";
import { sendTelegramMessage } from "./telegram";
import { log } from "./logger";
// Ledger read-model is the SINGLE owner of the closed-trade projection + integrity filters.
// Import PHANTOM/NO_PRICE from here so the journal and the ledger never drift (spec §5, §2.2).
import {
  toLedgerRow,
  computeStats,
  groupBy,
  PHANTOM_REASONS,
  NO_PRICE_REASONS,
  isOpsNoiseClose,
  type LedgerRow,
  type LedgerStats,
} from "./tradeLedger";

function israelMidnightUtc(now: Date): Date {
  // Start of "today" in Israel (UTC+3), expressed as a UTC Date.
  const il = new Date(now.getTime() + 3 * 3600_000);
  const ilMidnight = Date.UTC(il.getUTCFullYear(), il.getUTCMonth(), il.getUTCDate());
  return new Date(ilMidnight - 3 * 3600_000);
}

const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;

function exitReasonHe(reason: string | null | undefined): string {
  switch (reason) {
    case "TP_HIT_IBKR": return "TP נגע — נלקח רווח לפי התוכנית";
    case "SL_HIT_IBKR": return "SL נגע — נחתך הפסד מוגדר";
    case "MANUAL_CLOSE": return "סגירה ידנית";
    case "MANUAL_PARTIAL_CLOSE": return "הפחתה חלקית ידנית";
    case "CLOSED_IBKR": return "נסגר ב-IBKR (SL/TP או ידני)";
    case "CLOSED_IBKR_NO_PRICE":
    case "CLOSE_PRICE_UNKNOWN":
    case "CLOSE_PRICE_UNKNOWN_BREAKEVEN": return "נסגר ללא מחיר יציאה — P&L לא ידוע";
    default: return reason ?? "—";
  }
}

export interface DailyJournalData {
  dateLabelHe: string;
  closed: any[];          // real closed trades today (excl. phantoms)
  noPriceCount: number;   // closes with unknown P&L (A1) — caveat
  open: any[];            // currently-open positions
  realizedUsd: number;    // sum of KNOWN realized P&L only
  wins: number;
  losses: number;
  // ── Ledger read-model section (spec §5) — pre-filtered to the measurable set. ──
  ledger: LedgerSection;
  weekly: WeeklyRollup | null; // populated only on Sundays (Israel)
}

/** Measurable ledger projection for the day: overall + per-route + per-weekly-state splits. */
export interface LedgerSection {
  overall: LedgerStats;
  byRoute: Record<string, LedgerStats>;
  byWeekly: Record<string, LedgerStats>;
}

/** Trailing-7-day rollup (Sunday only). */
export interface WeeklyRollup {
  overall: LedgerStats;
  byRoute: Record<string, LedgerStats>;
  topRoute: { route: string; stats: LedgerStats } | null;
}

const YARDSTICK_MIN_DAYS = 1;
const YARDSTICK_MAX_DAYS = 10;

/**
 * Project raw closed rows → measurable LedgerRow[]: drop phantoms AND no-price closes
 * BEFORE computeStats (else fabricated $0 closes dilute win-rate — spec §2.2, §5.1). Never throws.
 */
function measurableLedgerRows(rawRows: any[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const r of rawRows ?? []) {
    try {
      const reason = r?.exitReason;
      if (PHANTOM_REASONS.includes(reason)) continue;
      if (NO_PRICE_REASONS.includes(reason)) continue;
      out.push(toLedgerRow(r));
    } catch {
      // defensive: a single malformed row must never break the report
    }
  }
  return out;
}

function buildLedgerSection(rawRows: any[]): LedgerSection {
  const rows = measurableLedgerRows(rawRows);
  return {
    overall: computeStats(rows),
    byRoute: groupBy(rows, (r) => r.route || "UNKNOWN"),
    byWeekly: groupBy(rows, (r) => r.weeklyState || "—"),
  };
}

export async function buildDailyJournalData(userId: number, now: Date): Promise<DailyJournalData | null> {
  const db = await getDb();
  if (!db) return null;
  const since = israelMidnightUtc(now);

  const closedRaw = await db.select().from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      eq(livePositions.status, "closed"),
      gte(livePositions.closedAt, since),
    ))
    .orderBy(desc(livePositions.closedAt));

  // Drop ops-noise closes (phantom, reconcile, no-price) from the trader-facing report.
  const journalClosed = closedRaw.filter((r: any) => !isOpsNoiseClose(r.exitReason));
  const noPriceCount = closedRaw.filter((r: any) => NO_PRICE_REASONS.includes(r.exitReason)).length;

  const open = await db.select().from(livePositions)
    .where(and(eq(livePositions.userId, userId), inArray(livePositions.status, ["open", "zombie"] as any)))
    .orderBy(livePositions.ticker);

  const il = new Date(now.getTime() + 3 * 3600_000);
  const dateLabelHe = `${il.getUTCDate()}.${il.getUTCMonth() + 1}.${il.getUTCFullYear()}`;

  // Ledger section over today's real closes (route × weekly × win-rate/expectancy).
  // measurableLedgerRows drops phantoms + no-price rows, banks partialRealizedPnl, and
  // classifies with the canonical BE band — so ledger.overall IS the honest headline.
  const ledger = buildLedgerSection(journalClosed);

  // Headline derives from ledger.overall (single source) so the two win-counts in one
  // report can never disagree. Was a divergent raw reduce on realizedPnl (>0/<0, no BE
  // band, ignored partialRealizedPnl) — the root of the false 20% win-rate / 54 "breakeven".
  const realizedUsd = ledger.overall.totalPnl;
  const wins = ledger.overall.wins;
  const losses = ledger.overall.losses;

  // Sunday weekly rollup (Israel): getUTCDay()===0 on the Israel-local clock.
  const weekly = il.getUTCDay() === 0 ? await buildWeeklyRollup(db, userId, now) : null;

  return { dateLabelHe, closed: journalClosed, noPriceCount, open, realizedUsd, wins, losses, ledger, weekly };
}

/**
 * Trailing-7-day weekly rollup, fired on Sundays. Reads closed rows over the last 7 Israel-days,
 * pre-filters to the measurable set, and computes overall + per-route stats + the top route by
 * expectancy. Degrade-safe: returns null on any DB failure (never blocks the daily send).
 */
async function buildWeeklyRollup(db: any, userId: number, now: Date): Promise<WeeklyRollup | null> {
  try {
    const weekStart = new Date(israelMidnightUtc(now).getTime() - 7 * 86_400_000);
    const raw = await db.select().from(livePositions)
      .where(and(
        eq(livePositions.userId, userId),
        eq(livePositions.status, "closed"),
        gte(livePositions.closedAt, weekStart),
      ))
      .orderBy(desc(livePositions.closedAt));

    const rows = measurableLedgerRows(raw);
    const overall = computeStats(rows);
    const byRoute = groupBy(rows, (r) => r.route || "UNKNOWN");

    // Top route = highest expectancyR among routes with at least one decided trade.
    let topRoute: { route: string; stats: LedgerStats } | null = null;
    for (const route of Object.keys(byRoute)) {
      const s = byRoute[route];
      if (s.wins + s.losses === 0) continue;
      if (!topRoute || s.expectancyR > topRoute.stats.expectancyR) topRoute = { route, stats: s };
    }

    return { overall, byRoute, topRoute };
  } catch (e: any) {
    log.warn("JOURNAL", `Weekly rollup failed (non-blocking): ${e?.message ?? e}`);
    return null;
  }
}

/** One rule-derived insight (the "hybrid" line — deterministic for v1, swappable for a real LLM later). */
function insightOfTheDay(d: DailyJournalData): string {
  if (d.closed.length === 0 && d.open.length > 0)
    return "יום של החזקה — לא נסגרו עסקאות אמיתיות; ניהול בסבלנות הוא חלק מהאסטרטגיה.";
  const total = d.wins + d.losses;
  if (total > 0 && d.wins / total >= 0.6)
    return "יום ממושמע — רוב היציאות לפי התוכנית. לשמר את אותה משמעת.";
  if (d.realizedUsd < 0)
    return "יום אדום — בדוק אם ההפסדים נחתכו ב-SL לפי הכלל, או נמשכו מעבר לתוכנית.";
  if (d.realizedUsd > 0)
    return "יום ירוק — המשך לפי הכללים, בלי לרדוף.";
  return "יום שקט — המשך לפי הכללים.";
}

const pct = (n: number) => `${Math.round(n)}%`;
const rStr = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}R`;

/** Format one stats bucket as a compact line: "n · win% · +R · $". */
function statLine(label: string, s: LedgerStats): string {
  const decided = s.wins + s.losses;
  const wr = decided > 0 ? pct(s.winRatePct) : "—";
  return `• <b>${label}</b>: ${s.trades} · ${wr} · ${rStr(s.expectancyR)} · ${money(s.totalPnl)}`;
}

/** Median holdDays vs the 1–10-day yardstick (over-hold flagged). */
function holdLine(median: number | null): string {
  if (median === null) return `⏱️ זמן החזקה חציוני: — (יעד ${YARDSTICK_MIN_DAYS}–${YARDSTICK_MAX_DAYS} ימים)`;
  const md = median.toFixed(1);
  const flag = median > YARDSTICK_MAX_DAYS ? " ⚠️ מעבר ליעד" : median < YARDSTICK_MIN_DAYS ? " (קצר)" : "";
  return `⏱️ זמן החזקה חציוני: ${md} ימים (יעד ${YARDSTICK_MIN_DAYS}–${YARDSTICK_MAX_DAYS})${flag}`;
}

/** The ledger section (spec §5): overall win-rate/expectancy, per-route, per-weekly, holdDays. */
function formatLedgerSection(sec: LedgerSection): string[] {
  const lines: string[] = [];
  const o = sec.overall;
  if (o.trades === 0) return lines; // nothing measurable today — keep the report clean

  lines.push("\n📊 <b>למידה — ניתוח לדג'ר</b>");
  const decided = o.wins + o.losses;
  const wr = decided > 0 ? pct(o.winRatePct) : "—";
  lines.push(`🎯 כללי: ${o.trades} עסקאות · ${wr} הצלחה · תוחלת ${rStr(o.expectancyR)} · ${money(o.totalPnl)}`);
  lines.push(holdLine(o.medianHoldDays));

  const routes = Object.keys(sec.byRoute).sort((a, b) => sec.byRoute[b].trades - sec.byRoute[a].trades);
  if (routes.length) {
    lines.push("\n🛣️ <b>לפי מסלול</b>");
    for (const r of routes.slice(0, 8)) lines.push(statLine(r, sec.byRoute[r]));
  }

  const weeklies = Object.keys(sec.byWeekly).sort((a, b) => sec.byWeekly[b].trades - sec.byWeekly[a].trades);
  if (weeklies.length > 1 || (weeklies.length === 1 && weeklies[0] !== "—")) {
    lines.push("\n📅 <b>לפי מצב שבועי</b>");
    for (const w of weeklies.slice(0, 6)) lines.push(statLine(w, sec.byWeekly[w]));
  }
  return lines;
}

/** Sunday weekly rollup (spec §5.6). */
function formatWeeklyRollup(w: WeeklyRollup): string[] {
  const lines: string[] = [];
  const o = w.overall;
  lines.push("\n🗓️ <b>סיכום שבועי (7 ימים)</b>");
  if (o.trades === 0) {
    lines.push("אין עסקאות שנמדדו השבוע.");
    return lines;
  }
  const decided = o.wins + o.losses;
  const wr = decided > 0 ? pct(o.winRatePct) : "—";
  lines.push(`📈 ${o.trades} עסקאות · ${wr} הצלחה · תוחלת ${rStr(o.expectancyR)} · ${money(o.totalPnl)}`);
  lines.push(holdLine(o.medianHoldDays));
  if (w.topRoute) {
    lines.push(`🏆 מסלול מוביל (תוחלת): <b>${w.topRoute.route}</b> · ${rStr(w.topRoute.stats.expectancyR)}`);
  }
  return lines;
}

export function formatDailyJournal(d: DailyJournalData): string {
  const lines: string[] = [];
  lines.push(`📓 <b>יומן מסחר — Elza | ${d.dateLabelHe}</b>`);
  lines.push(`🕥 סיכום 23:10`);
  lines.push("━━━━━━━━━━━━━━");

  const total = d.wins + d.losses;
  const winRate = total > 0 ? Math.round((d.wins / total) * 100) : 0;
  lines.push(`💰 ממומש (ידוע): <b>${money(d.realizedUsd)}</b> · נצחונות ${d.wins}/${total} (${winRate}%)`);
  lines.push(`📂 פתוחות: ${d.open.length} · נסגרו היום (אמיתיות): ${d.closed.length}`);

  if (d.closed.length) {
    lines.push("\n🔴 <b>עסקאות שנסגרו</b>");
    for (const t of d.closed.slice(0, 12)) {
      const p = Number(t.realizedPnl ?? 0);
      const unknown = NO_PRICE_REASONS.includes(t.exitReason);
      const tag = unknown ? "❓" : p > 0 ? "✅" : p < 0 ? "🔴" : "➖";
      const pnlStr = unknown ? "P&L לא ידוע" : money(p);
      lines.push(`${tag} <b>${t.ticker}</b> ${t.direction} ${t.units}u · ${pnlStr}`);
      lines.push(`   ↳ ${exitReasonHe(t.exitReason)}`);
    }
  }

  if (d.open.length) {
    lines.push("\n🟢 <b>פתוחות — לקראת מחר</b>");
    for (const o of d.open.slice(0, 12)) {
      const u = o.unrealizedPnl != null ? ` · ${money(Number(o.unrealizedPnl))}` : "";
      const prot = o.currentSl ? `SL $${Number(o.currentSl).toFixed(2)}` : "ללא SL ⚠️";
      lines.push(`• <b>${o.ticker}</b> ${o.direction} ${o.units}u${u} · ${prot}`);
    }
  }

  // ── Ledger learning section (ADDED) — never throws; never blocks the report above. ──
  try {
    if (d.ledger) lines.push(...formatLedgerSection(d.ledger));
    if (d.weekly) lines.push(...formatWeeklyRollup(d.weekly));
  } catch (e: any) {
    log.warn("JOURNAL", `Ledger section render failed (non-blocking): ${e?.message ?? e}`);
  }

  lines.push("\n🧠 <b>תובנת היום</b>");
  lines.push(insightOfTheDay(d));
  lines.push("━━━━━━━━━━━━━━");
  lines.push("<i>אוטומטי · 23:10 · נלמד מזה</i>");
  return lines.join("\n");
}

/** Build + send the daily journal to Telegram. Returns true if sent. */
export async function sendDailyTradingJournal(userId = 1, now = new Date()): Promise<boolean> {
  try {
    const data = await buildDailyJournalData(userId, now);
    if (!data) { log.warn("JOURNAL", "No DB — journal skipped"); return false; }

    // Skip entirely on pure ops-noise days with nothing open to report.
    const hasMeasurable = data.ledger.overall.trades > 0;
    const hasRealCloses = data.closed.length > 0;
    if (!hasRealCloses && !hasMeasurable && data.open.length === 0 && Math.abs(data.realizedUsd) < 1) {
      log.info("JOURNAL", "Skipped — ops-noise only (reconcile/phantom/no-price), no open positions");
      return false;
    }

    const msg = formatDailyJournal(data);
    await sendTelegramMessage(msg);
    log.info("JOURNAL", `Daily trading journal sent — ${data.closed.length} closed, ${data.open.length} open, realized ${data.realizedUsd.toFixed(0)}`);
    return true;
  } catch (e: any) {
    log.error("JOURNAL", `Daily journal failed: ${e?.message ?? e}`);
    return false;
  }
}

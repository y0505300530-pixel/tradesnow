/**
 * learnPatterns.ts
 * Extracts recurring technical patterns from mentor video analyses
 * and upserts them into the mentorPatterns table.
 *
 * Called after each autoSyncAndAnalyze run.
 */

import { getDb } from "../db";
import { mentorPatterns, analyses, channelVideos, agentInsights } from "../../drizzle/schema";
import { eq, desc, and, gte, inArray } from "drizzle-orm";

// Known pattern keywords to detect from analysisResult
const PATTERN_KEYWORDS: { name: string; keywords: RegExp }[] = [
  { name: "Gold Retest",         keywords: /gold retest|retest.*support|גולד ריטסט|בדיקה חוזרת/i },
  { name: "Donchian Breakout",   keywords: /donchian|20.day (high|low)|שבירת שיא 20/i },
  { name: "Bull Trend Pullback", keywords: /bull.*pullback|pullback.*uptrend|פולבק.*עולה/i },
  { name: "Cup & Handle",        keywords: /cup.{0,10}handle|כוס.*ידית/i },
  { name: "Bear Breakdown",      keywords: /bear breakdown|שבירת תמיכה|ירידה מתחת/i },
  { name: "Demand Zone Entry",   keywords: /demand zone|אזור ביקוש/i },
  { name: "Breakout Consolidation", keywords: /breaking out.*consolidat|פריצה.*קונסולידציה/i },
  { name: "Volume Spike",        keywords: /volume spike|ספייק נפח|עלייה בנפח/i },
  { name: "ATR Stop Loss",       keywords: /atr.*stop|stop.*atr|סטופ.*atr/i },
  { name: "Waiting for Pullback",keywords: /wait.*pullback|ממתין.*לפולבק|watchlist.*pullback/i },
  { name: "All Time High Break", keywords: /all.time high|שיא כל הזמנים/i },
];

export async function learnPatternsFromAnalyses(userId: number): Promise<{
  patternsUpdated: number;
  newPatterns: string[];
  insights: { title: string; body: string; type: string; priority: string }[];
}> {
  const db = await getDb();
  if (!db) return { patternsUpdated: 0, newPatterns: [], insights: [] };

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30 days

  // Load recent analyses
  const recentAnalyses = await db
    .select({ id: analyses.id, videoId: analyses.videoId, analysisResult: analyses.analysisResult })
    .from(analyses)
    .where(and(eq(analyses.userId, userId), eq(analyses.status, "done"), gte(analyses.createdAt, cutoff)))
    .orderBy(desc(analyses.createdAt))
    .limit(50);

  const videoIds = recentAnalyses.map(a => a.videoId).filter(Boolean) as string[];
  const videos = videoIds.length > 0
    ? await db.select({ videoId: channelVideos.videoId, mentor: channelVideos.mentor })
        .from(channelVideos)
        .where(inArray(channelVideos.videoId, videoIds))
    : [];

  // Fallback: build mentor map from channel name
  const videoMentorMap = new Map(videos.map(v => [v.videoId, v.mentor]));

  // Count pattern occurrences across all analyses
  const patternCounts = new Map<string, {
    mentor: Set<"cycles_trading"|"micha_stocks">;
    tickers: Set<string>;
    examples: { videoId: string; quote: string }[];
  }>();

  for (const analysis of recentAnalyses) {
    if (!analysis.analysisResult) continue;
    try {
      const parsed = JSON.parse(analysis.analysisResult) as {
        rows?: Array<Record<string, string>>;
        general_notes?: string;
      };
      const rows = parsed.rows ?? [];
      const mentor = analysis.videoId
        ? (videoMentorMap.get(analysis.videoId) ?? "cycles_trading")
        : "cycles_trading";

      for (const row of rows) {
        const combined = [
          row.strategy ?? "", row.entry_zone ?? "", row.watchlist ?? "", row.catalyst ?? ""
        ].join(" ");

        for (const { name, keywords } of PATTERN_KEYWORDS) {
          if (keywords.test(combined)) {
            if (!patternCounts.has(name)) {
              patternCounts.set(name, { mentor: new Set(), tickers: new Set(), examples: [] });
            }
            const entry = patternCounts.get(name)!;
            entry.mentor.add(mentor as "cycles_trading"|"micha_stocks");
            if (row.ticker && row.ticker !== "—") entry.tickers.add(row.ticker.toUpperCase());
            if (entry.examples.length < 5 && analysis.videoId) {
              entry.examples.push({ videoId: analysis.videoId, quote: combined.slice(0, 80) });
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  // Upsert patterns into DB
  let patternsUpdated = 0;
  const newPatterns: string[] = [];
  const insightsToCreate: { title: string; body: string; type: string; priority: string }[] = [];

  for (const [name, data] of patternCounts.entries()) {
    const mentorVal: "cycles_trading"|"micha_stocks"|"both" =
      data.mentor.size >= 2 ? "both"
      : [...data.mentor][0] === "micha_stocks" ? "micha_stocks"
      : "cycles_trading";

    // Check if already exists
    const existing = await db
      .select({ id: mentorPatterns.id, occurrences: mentorPatterns.occurrences })
      .from(mentorPatterns)
      .where(and(
        eq(mentorPatterns.userId, userId),
        eq(mentorPatterns.mentor, mentorVal),
        eq(mentorPatterns.patternName, name),
      ))
      .limit(1);

    const tickersArr = [...data.tickers].slice(0, 20);
    const description = `דפוס "${name}" זוהה ${data.examples.length} פעמים בסרטונים האחרונים.` +
      (tickersArr.length > 0 ? ` מניות לדוגמה: ${tickersArr.slice(0,5).join(", ")}.` : "");

    if (existing.length === 0) {
      await db.insert(mentorPatterns).values({
        userId,
        mentor: mentorVal,
        patternName: name,
        description,
        occurrences: data.examples.length,
        tickers: JSON.stringify(tickersArr),
        rawExamples: JSON.stringify(data.examples),
        lastSeenAt: new Date(),
      });
      newPatterns.push(name);

      // Create insight for new pattern
      insightsToCreate.push({
        title: `דפוס חדש זוהה: ${name}`,
        body: description + `\n\nמנטור: ${mentorVal === "both" ? "Ziv + Micha" : mentorVal === "micha_stocks" ? "Micha" : "Ziv"}\nמניות: ${tickersArr.join(", ")}`,
        type: "pattern_learned",
        priority: mentorVal === "both" ? "high" : "medium",
      });
    } else {
      // Update occurrence count
      await db.update(mentorPatterns)
        .set({
          occurrences: existing[0].occurrences + data.examples.length,
          tickers: JSON.stringify(tickersArr),
          description,
          lastSeenAt: new Date(),
        })
        .where(eq(mentorPatterns.id, existing[0].id));
    }
    patternsUpdated++;
  }

  return { patternsUpdated, newPatterns, insights: insightsToCreate };
}

/** Build a daily AgentInsights summary from today's autoSync results */
export async function buildDailyInsights(userId: number, syncResults: {
  newVideos: number;
  analyzed: number;
  addedToCatalog: number;
  upgraded: number;
  tickers: Array<{ ticker: string; mentor: string; entryZone: string; signalScore: number; isNew: boolean }>;
  errors: string[];
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const today = new Date().toISOString().slice(0, 10);
  const insightsToInsert: Array<{
    userId: number; date: string; type: string; status: string;
    title: string; body: string; ticker: string | null;
    mentor: string | null; priority: string;
  }> = [];

  // 1. Daily summary
  const dualSignals = syncResults.tickers.filter(t => t.mentor.includes("+"));
  const newTickers  = syncResults.tickers.filter(t => t.isNew);

  insightsToInsert.push({
    userId, date: today,
    type: "daily_summary", status: "approved", // auto-approved, just for record
    title: `סיכום יומי — ${new Date().toLocaleDateString("he-IL")}`,
    body: [
      `📹 סרטונים חדשים שנסנקו: ${syncResults.newVideos}`,
      `🔬 סרטונים שנותחו: ${syncResults.analyzed}`,
      `📋 טיקרים שנוספו לקטלוג: ${syncResults.addedToCatalog}`,
      `⬆️ טיקרים שקיבלו Upgrade: ${syncResults.upgraded}`,
      `⭐ Dual Signals (זיו + מיכה): ${dualSignals.length}`,
      syncResults.errors.length > 0 ? `❌ שגיאות: ${syncResults.errors.slice(0,3).join(", ")}` : "",
    ].filter(Boolean).join("\n"),
    ticker: null, mentor: null,
    priority: syncResults.errors.length > 2 ? "high" : "low",
  });

  // 2. Dual signal insights — each one gets its own pending insight
  for (const t of dualSignals) {
    insightsToInsert.push({
      userId, date: today,
      type: "dual_signal", status: "pending",
      title: `⭐ Dual Signal: ${t.ticker} — גם זיו וגם מיכה`,
      body: [
        `הטיקר ${t.ticker} קיבל איתות חיובי משני המנטורים ב-14 הימים האחרונים.`,
        `ציון: ${t.signalScore.toFixed(1)}/10`,
        t.entryZone !== "—" ? `כניסה מוצעת: ${t.entryZone}` : "",
        ``,
        `האם להפעיל את הטיקר הזה במנוע המסחר?`,
      ].filter(Boolean).join("\n"),
      ticker: t.ticker, mentor: "both",
      priority: "high",
    });
  }

  // 3. New tickers with entry signals
  for (const t of newTickers.filter(t => t.entryZone !== "—").slice(0, 5)) {
    insightsToInsert.push({
      userId, date: today,
      type: "new_ticker", status: "pending",
      title: `טיקר חדש נכנס לקטלוג: ${t.ticker}`,
      body: [
        `הטיקר ${t.ticker} נוסף לקטלוג ב-Watch tier.`,
        `כניסה מוצעת: ${t.entryZone}`,
        `מנטור: ${t.mentor === "both" ? "Ziv + Micha" : t.mentor.includes("micha") ? "Micha" : "Ziv"}`,
        `ציון: ${t.signalScore.toFixed(1)}/10`,
      ].join("\n"),
      ticker: t.ticker, mentor: t.mentor,
      priority: t.signalScore >= 8.5 ? "high" : "medium",
    });
  }

  // Insert all
  for (const insight of insightsToInsert) {
    try {
      await db.insert(agentInsights).values({
        userId: insight.userId,
        date: new Date(insight.date),
        type: insight.type as "daily_summary"|"market_outlook"|"new_ticker"|"dual_signal"|"pattern_learned"|"code_change",
        status: insight.status as "pending"|"approved"|"rejected"|"applied",
        title: insight.title,
        body: insight.body,
        ticker: insight.ticker ?? null,
        mentor: insight.mentor ?? null,
        priority: insight.priority as "critical"|"high"|"medium"|"low",
      });
    } catch (e) { /* ignore duplicate */ }
  }
}

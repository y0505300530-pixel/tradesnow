/**
 * Telegram Group Monitor
 * Scrapes public Telegram channels via t.me/s/{handle} (no API key needed).
 * Classifies messages with LLM to find:
 *   1. Buy recommendations with upside targets
 *   2. Insider / stakeholder buying
 */

import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { telegramMonitorGroups, telegramMonitorMessages } from "../../drizzle/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { invokeLLM } from "../_core/llm";
import { log } from "../logger";
import * as https from "https";
import * as http from "http";

// ─── Scraper ─────────────────────────────────────────────────────────────────

interface ScrapedMessage {
  messageId: number;
  text: string;
  date: number; // unix timestamp ms
  senderName?: string;
}

/**
 * Scrape latest messages from a public Telegram channel via t.me/s/{handle}
 * Returns up to 20 most recent messages.
 */
function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function scrapePublicChannel(handle: string, afterMessageId?: number): Promise<ScrapedMessage[]> {
  const cleanHandle = handle.replace(/^@/, "");
  const url = `https://t.me/s/${cleanHandle}`;
  try {
    const html = await httpsGet(url);

    // Parse messages from Telegram's web preview HTML
    const messages: ScrapedMessage[] = [];

    // Each message block: <div class="tgme_widget_message_wrap ...">
    // Message ID is in data-post="channelname/12345"
    // Text is in <div class="tgme_widget_message_text ...">
    // Date is in <time datetime="2024-01-15T10:30:00+00:00">
    const messageBlockRegex = /<div[^>]+class="tgme_widget_message_wrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    const dataPostRegex = /data-post="[^/]+\/(\d+)"/;
    const textRegex = /<div[^>]+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
    const dateRegex = /<time[^>]+datetime="([^"]+)"/;
    const senderRegex = /<span[^>]+class="tgme_widget_message_from_author[^"]*"[^>]*>([^<]+)<\/span>/;

    // Simpler approach: find all data-post attributes and their associated content
    const postMatches = Array.from(html.matchAll(/data-post="([^"]+)"[\s\S]*?<time[^>]+datetime="([^"]+)"/g));

    for (const match of postMatches) {
      const postId = match[1]; // e.g. "gotliveir/1234"
      const msgId = parseInt(postId.split("/")[1] || "0");
      if (!msgId) continue;
      if (afterMessageId && msgId <= afterMessageId) continue;

      const dateStr = match[2];
      const date = dateStr ? new Date(dateStr).getTime() : Date.now();

      // Extract text around this match position — use a larger window to capture full message
      const matchStart = match.index ?? 0;
      const snippet = html.slice(matchStart, matchStart + 8000);

      // Extract text content — match tgme_widget_message_text (may also have js-message_text class)
      // Handle dir="auto" attribute and nested content
      const textMatch = snippet.match(/<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>(?:\s*(?:<div|<a\s+class="tgme_widget_message_inline_button|<\/div))/);
      // Also try simpler pattern for channels that use dir="auto"
      const textMatchAlt = !textMatch ? snippet.match(/class="[^"]*js-message_text[^"]*"[^>]*>([\s\S]{10,800}?)<\/div>/) : null;
      let text = "";
      const effectiveMatch = textMatch || textMatchAlt;
      if (effectiveMatch) {
        text = effectiveMatch[1]
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, " ")
          .trim();
      }

      if (!text || text.length < 10) continue;

      const senderMatch = snippet.match(/<span[^>]+class="tgme_widget_message_from_author[^"]*"[^>]*>([^<]+)<\/span>/);
      const senderName = senderMatch ? senderMatch[1].trim() : undefined;

      messages.push({ messageId: msgId, text, date, senderName });
    }

    return messages.sort((a, b) => b.messageId - a.messageId).slice(0, 30);
  } catch (err: any) {
    log.warn("TELEGRAM", `Failed to scrape ${handle}`, { error: err?.message });
    return [];
  }
}

// ─── LLM Classifier ──────────────────────────────────────────────────────────

interface ClassificationResult {
  isRelevant: boolean;
  category: "buy_recommendation" | "insider_buying" | "other";
  ticker?: string;
  upside?: string;
  summary?: string;
}

async function classifyMessage(text: string): Promise<ClassificationResult> {
  const prompt = `You are a financial message classifier for an Israeli trading platform.

Analyze the following message from a Telegram investment group and classify it.

RELEVANT categories:
1. "buy_recommendation" — A stock buy recommendation with a price target or upside percentage (e.g., "קנייה על NVDA עם יעד $150", "המלצת קנייה עם אפסייד של 30%")
2. "insider_buying" — Insider buying, stakeholder purchase, or significant institutional buying (e.g., "בעל עניין רכש מניות", "CEO bought shares", "רכישה עצמית")

NOT relevant: general news, earnings reports, market commentary without specific buy recommendation, sell recommendations, price drops.

Message:
"""
${text.slice(0, 800)}
"""

Respond with JSON only:
{
  "isRelevant": boolean,
  "category": "buy_recommendation" | "insider_buying" | "other",
  "ticker": "TICKER_SYMBOL or null",
  "upside": "upside percentage or price target as string, or null",
  "summary": "1-2 sentence Hebrew summary of the key point, or null if not relevant"
}`;

  try {
    const resp = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" } as any,
      max_tokens: 200,
    } as any);
    const content = resp?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
    return {
      isRelevant: !!parsed.isRelevant,
      category: parsed.category || "other",
      ticker: parsed.ticker || undefined,
      upside: parsed.upside || undefined,
      summary: parsed.summary || undefined,
    };
  } catch {
    return { isRelevant: false, category: "other" };
  }
}

// ─── Poll all active groups for a user ───────────────────────────────────────

export async function pollMonitorGroups(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const groups = await db.select().from(telegramMonitorGroups)
    .where(and(eq(telegramMonitorGroups.userId, userId), eq(telegramMonitorGroups.isActive, true)));

  for (const group of groups) {
    try {
      const messages = await scrapePublicChannel(group.groupHandle, group.lastMessageId ?? undefined);
      if (messages.length === 0) continue;

      let maxMessageId = group.lastMessageId ?? 0;

      for (const msg of messages) {
        // Classify with LLM
        const cls = await classifyMessage(msg.text);

        // Save to DB (all messages, but mark isRelevant)
        await db.insert(telegramMonitorMessages).values({
          userId,
          groupId: group.id,
          groupHandle: group.groupHandle,
          messageId: msg.messageId,
          messageText: msg.text,
          messageDate: msg.date,
          senderName: msg.senderName,
          category: cls.category,
          ticker: cls.ticker,
          upside: cls.upside,
          summary: cls.summary,
          isRelevant: cls.isRelevant,
          capturedAt: Date.now(),
        }).onDuplicateKeyUpdate({ set: { capturedAt: Date.now() } });

        if (msg.messageId > maxMessageId) maxMessageId = msg.messageId;
      }

      // Update lastMessageId and lastCheckedAt
      await db.update(telegramMonitorGroups)
        .set({ lastMessageId: maxMessageId, lastCheckedAt: Date.now() })
        .where(eq(telegramMonitorGroups.id, group.id));

      log.info("TELEGRAM", `Polled ${group.groupHandle}: ${messages.length} messages, ${messages.filter(m => m.messageId > (group.lastMessageId ?? 0)).length} new`);
    } catch (err: any) {
      log.error("TELEGRAM", `Poll error for ${group.groupHandle}`, { error: err?.message });
    }
  }
}

// ─── tRPC Router ─────────────────────────────────────────────────────────────

export const telegramMonitorRouter = router({
  // List all monitored groups for this user
  listGroups: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(telegramMonitorGroups)
      .where(eq(telegramMonitorGroups.userId, ctx.user.id))
      .orderBy(desc(telegramMonitorGroups.createdAt));
  }),

  // Add a new group to monitor (admin only) — auto-scrapes last 10 messages immediately
  addGroup: adminProcedure.input(z.object({
    groupHandle: z.string().min(2).max(128),
    displayName: z.string().max(128).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const handle = input.groupHandle.startsWith("@") ? input.groupHandle : `@${input.groupHandle}`;

    // Insert the group
    await db.insert(telegramMonitorGroups).values({
      userId: ctx.user.id,
      groupHandle: handle,
      displayName: input.displayName || handle,
      isActive: true,
      createdAt: Date.now(),
    });

    // Fetch the newly inserted group to get its ID
    const [newGroup] = await db.select().from(telegramMonitorGroups)
      .where(and(
        eq(telegramMonitorGroups.userId, ctx.user.id),
        eq(telegramMonitorGroups.groupHandle, handle),
      ))
      .orderBy(desc(telegramMonitorGroups.createdAt))
      .limit(1);

    if (!newGroup) return { ok: true, seeded: 0 };

    // Immediately scrape last 10 messages (no afterMessageId filter)
    const messages = await scrapePublicChannel(handle);
    const last10 = messages.slice(0, 10);

    let seeded = 0;
    let maxMessageId = 0;

    for (const msg of last10) {
      const cls = await classifyMessage(msg.text);
      await db.insert(telegramMonitorMessages).values({
        userId: ctx.user.id,
        groupId: newGroup.id,
        groupHandle: handle,
        messageId: msg.messageId,
        messageText: msg.text,
        messageDate: msg.date,
        senderName: msg.senderName,
        category: cls.category,
        ticker: cls.ticker,
        upside: cls.upside,
        summary: cls.summary,
        isRelevant: cls.isRelevant,
        capturedAt: Date.now(),
      }).onDuplicateKeyUpdate({ set: { capturedAt: Date.now() } });

      if (msg.messageId > maxMessageId) maxMessageId = msg.messageId;
      if (cls.isRelevant) seeded++;
    }

    // Update lastMessageId so future polls only fetch newer messages
    if (maxMessageId > 0) {
      await db.update(telegramMonitorGroups)
        .set({ lastMessageId: maxMessageId, lastCheckedAt: Date.now() })
        .where(eq(telegramMonitorGroups.id, newGroup.id));
    }

    log.info("TELEGRAM", `Seeded ${handle}: ${last10.length} messages scanned, ${seeded} relevant`);
    return { ok: true, seeded, total: last10.length };
  }),

  // Toggle group active/inactive (admin only)
  toggleGroup: adminProcedure.input(z.object({
    groupId: z.number(),
    isActive: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    await db.update(telegramMonitorGroups)
      .set({ isActive: input.isActive })
      .where(and(eq(telegramMonitorGroups.id, input.groupId), eq(telegramMonitorGroups.userId, ctx.user.id)));
    return { ok: true };
  }),

  // Delete a group (admin only)
  deleteGroup: adminProcedure.input(z.object({
    groupId: z.number(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    await db.delete(telegramMonitorGroups)
      .where(and(eq(telegramMonitorGroups.id, input.groupId), eq(telegramMonitorGroups.userId, ctx.user.id)));
    return { ok: true };
  }),

  // Get relevant messages (filtered feed)
  getMessages: protectedProcedure.input(z.object({
    category: z.enum(["all", "buy_recommendation", "insider_buying"]).default("all"),
    limit: z.number().min(1).max(100).default(50),
  })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const query = db.select().from(telegramMonitorMessages)
      .where(
        input.category === "all"
          ? and(eq(telegramMonitorMessages.userId, ctx.user.id), eq(telegramMonitorMessages.isRelevant, true))
          : and(
              eq(telegramMonitorMessages.userId, ctx.user.id),
              eq(telegramMonitorMessages.isRelevant, true),
              eq(telegramMonitorMessages.category, input.category)
            )
      )
      .orderBy(desc(telegramMonitorMessages.messageDate))
      .limit(input.limit);
    return query;
  }),

  // Manually trigger a poll for all active groups (admin only)
  pollNow: adminProcedure.mutation(async ({ ctx }) => {
    // Run in background
    pollMonitorGroups(ctx.user.id).catch(err =>
      log.error("TELEGRAM", "Manual poll error", { error: err?.message })
    );
    return { ok: true, message: "Polling started in background" };
  }),

  // Get all messages (including non-relevant) for a specific group — for "הודעות אחרונות" tab
  getGroupMessages: protectedProcedure.input(z.object({
    groupId: z.number(),
    limit: z.number().min(1).max(50).default(10),
  })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(telegramMonitorMessages)
      .where(and(
        eq(telegramMonitorMessages.userId, ctx.user.id),
        eq(telegramMonitorMessages.groupId, input.groupId),
      ))
      .orderBy(desc(telegramMonitorMessages.messageDate))
      .limit(input.limit);
  }),

  // Fetch and aggregate RSS feeds from Israeli financial news sources
  getRssFeed: protectedProcedure.query(async () => {
    const RSS_SOURCES = [
      { id: "globes", name: "גלובס", url: "https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=2", color: "#e63946" },
      { id: "calcalist", name: "כלכליסט", url: "https://www.calcalist.co.il/GeneralRSS/0,16335,L-1025,00.xml", color: "#f4a261" },
      { id: "themarker", name: "TheMarker", url: "https://www.themarker.com/cmlink/1.144", color: "#2a9d8f" },
      { id: "sponser_news", name: "ספונסר חדשות", url: "https://www.sponser.co.il/RssNews.xml", color: "#457b9d" },
      { id: "sponser_forum", name: "ספונסר פורום", url: "https://www.sponser.co.il/RssForum.xml", color: "#6a4c93" },
    ];

    const FEED_TIMEOUT_MS = 8_000;
    const MAX_BODY_BYTES = 512 * 1024;

    async function fetchUrl(url: string, redirectDepth = 0): Promise<string> {
      if (redirectDepth > 3) throw new Error("too many redirects");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TradeSnow RSS reader)",
            Accept: "application/rss+xml, application/xml, text/xml, */*",
          },
          redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) throw new Error(`redirect without location (${res.status})`);
          const nextUrl = new URL(location, url).toString();
          return fetchUrl(nextUrl, redirectDepth + 1);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BODY_BYTES) {
          throw new Error("response too large");
        }
        const bytes = new Uint8Array(buf);
        let text = new TextDecoder("utf-8").decode(bytes);
        if (text.includes("\uFFFD") || /charset=["']?windows-1255/i.test(text)) {
          try {
            text = new TextDecoder("windows-1255").decode(bytes);
          } catch { /* keep utf8 */ }
        }
        return text;
      } finally {
        clearTimeout(timer);
      }
    }

    function parseRss(xml: string, source: typeof RSS_SOURCES[0]) {
      const items: Array<{
        id: string;
        sourceId: string;
        sourceName: string;
        sourceColor: string;
        title: string;
        description: string;
        link: string;
        pubDate: number;
      }> = [];

      // Extract <item> blocks
      const itemBlocks = Array.from(xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g));
      for (const block of itemBlocks) {
        const content = block[1];

        const titleMatch = content.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        const linkMatch = content.match(/<link>([\s\S]*?)<\/link>/) ||
                          content.match(/<link[^>]+href="([^"]+)"/);
        const descMatch = content.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
        const dateMatch = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ||
                          content.match(/<dc:date>([\s\S]*?)<\/dc:date>/);

        const title = (titleMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
        const link = (linkMatch?.[1] ?? "").trim();
        const description = (descMatch?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
        const dateStr = (dateMatch?.[1] ?? "").trim();
        const pubDate = dateStr ? new Date(dateStr).getTime() : 0;

        if (!title || !link) continue;

        items.push({
          id: `${source.id}_${link}`,
          sourceId: source.id,
          sourceName: source.name,
          sourceColor: source.color,
          title,
          description: description.slice(0, 300),
          link,
          pubDate: isNaN(pubDate) ? 0 : pubDate,
        });
      }
      return items;
    }

    // Fetch all feeds in parallel
    const results = await Promise.allSettled(
      RSS_SOURCES.map(async (src) => {
        const xml = await fetchUrl(src.url);
        return parseRss(xml, src);
      })
    );

    const allItems = results
      .filter((r): r is PromiseFulfilledResult<ReturnType<typeof parseRss>> => r.status === "fulfilled")
      .flatMap(r => r.value);

    // Sort by pubDate descending (newest first)
    allItems.sort((a, b) => b.pubDate - a.pubDate);

    return allItems.slice(0, 100); // Return top 100 items
  }),

  // Get unread count (relevant messages in last 24h)
  getUnreadCount: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return 0;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await db.select().from(telegramMonitorMessages)
      .where(and(
        eq(telegramMonitorMessages.userId, ctx.user.id),
        eq(telegramMonitorMessages.isRelevant, true),
      ));
    return rows.filter(r => r.capturedAt > since).length;
  }),
});

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { ENV } from "../_core/env.js";
import {
  createAnalysis,
  getAnalysisById,
  getAnalysesByUser,
  updateAnalysis,
  createBulkSession,
  updateBulkSession,
  linkAnalysisToBulkSession,
  getBulkSessionWithAnalyses,
  getBulkSessionsByUser,
  getMasterKnowledgeByUser,
  upsertMasterKnowledge,
  getChannelVideoByVideoId,
} from "../db";

// ─── Utilities ─────────────────────────────────────────────────────────────

/**
 * Reliable fetch with a hard timeout using a manual AbortController.
 * More dependable than AbortSignal.timeout() across all Node.js environments.
 */
function fetchWithTimeout(url: string, options: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${ms}ms`)), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ─── YouTube helpers ────────────────────────────────────────────────────────

export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function fetchYouTubeMetadata(videoId: string) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {},
      8_000
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string; author_name?: string };
    return {
      title: data.title ?? null,
      channelName: data.author_name ?? null,
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the original YouTube video publish date.
 * Priority: channelVideos DB table → Supadata video API → null
 * This is the ONLY correct source for signal dates — never use analysis.createdAt.
 */
async function fetchVideoPublishDate(videoId: string): Promise<Date | null> {
  // Priority 1: channelVideos table (most reliable — already stored during channel sync)
  try {
    const channelVideo = await getChannelVideoByVideoId(videoId);
    if (channelVideo?.uploadDate) {
      return new Date(channelVideo.uploadDate);
    }
  } catch {
    // fall through
  }

  // Priority 2: Supadata video info API
  try {
    const apiKey = ENV.supadataApiKey;
    if (apiKey) {
      const res = await fetchWithTimeout(
        `https://api.supadata.ai/v1/youtube/video?videoId=${videoId}`,
        { headers: { "x-api-key": apiKey } },
        8_000
      );
      if (res.ok) {
        const data = (await res.json()) as {
          publishedAt?: string;
          published_at?: string;
          uploadDate?: string;
          upload_date?: string;
        };
        const rawDate =
          data.publishedAt ?? data.published_at ?? data.uploadDate ?? data.upload_date;
        if (rawDate) {
          const parsed = new Date(rawDate);
          if (!isNaN(parsed.getTime())) return parsed;
        }
      }
    }
  } catch {
    // fall through
  }

  // No publish date found — caller must handle null (do NOT fall back to today's date)
  return null;
}

/** Try to get captions via the youtube-transcript library (fast path) */
async function tryFetchCaptions(videoId: string): Promise<string | null> {
  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    // Race against a 20s timeout — the library has no built-in timeout
    const segmentsPromise = YoutubeTranscript.fetchTranscript(videoId);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Caption fetch timed out")), 20_000)
    );
    const segments = await Promise.race([segmentsPromise, timeoutPromise]);
    if (!segments || segments.length === 0) return null;
    return segments.map((s) => s.text).join(" ");
  } catch {
    return null;
  }
}

// ─── AI analysis ────────────────────────────────────────────────────────────

export interface TradingRow {
  ticker: string;
  company: string;
  strategy: string;
  entry_zone: string;
  stop_loss: string;
  catalyst: string;
  tradingview_alert: string;
  watchlist: string;
  mentor_confidence: number; // 1–5 confidence score (Phase 1 v1.0)
  signal_bias: "LONG" | "SHORT" | "WATCH" | "REJECTED"; // Phase 1 v1.0 — Hebrew Slang Guard output
}

const TRADING_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "trading_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              company: { type: "string" },
              strategy: { type: "string" },
              entry_zone: { type: "string" },
              stop_loss: { type: "string" },
              catalyst: { type: "string" },
              tradingview_alert: { type: "string" },
              watchlist: { type: "string" },
              mentor_confidence: { type: "number" },
              signal_bias: { type: "string", enum: ["LONG", "SHORT", "WATCH", "REJECTED"] },
            },
            required: ["ticker", "company", "strategy", "entry_zone", "stop_loss", "catalyst", "tradingview_alert", "watchlist", "mentor_confidence", "signal_bias"],
            additionalProperties: false,
          },
        },
        general_notes: { type: "string" },
      },
      required: ["rows", "general_notes"],
      additionalProperties: false,
    },
  },
};

type TradingAnalysisResult = { rows: TradingRow[]; general_notes: string };

/** Strip markdown fences and extract the outermost JSON object from LLM text. */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("AI response did not contain valid JSON.");

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  // Truncated output — return from first brace; salvageTruncatedTradingJson handles repair
  return candidate.slice(start);
}

/** Salvage complete row objects from truncated JSON (e.g. when output token limit cuts mid-array). */
function salvageTruncatedTradingJson(jsonStr: string): TradingAnalysisResult | null {
  const rowsKey = jsonStr.indexOf('"rows"');
  if (rowsKey === -1) return null;
  const arrayStart = jsonStr.indexOf("[", rowsKey);
  if (arrayStart === -1) return null;

  const rows: TradingRow[] = [];
  let depth = 0;
  let objStart = -1;

  for (let i = arrayStart + 1; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(jsonStr.slice(objStart, i + 1)) as TradingRow;
          if (obj.ticker) rows.push(obj);
        } catch { /* skip partial object */ }
        objStart = -1;
      }
    }
  }

  if (rows.length === 0) return null;

  let general_notes = "—";
  const notesIdx = jsonStr.indexOf('"general_notes"');
  if (notesIdx !== -1) {
    const colon = jsonStr.indexOf(":", notesIdx);
    const quote = jsonStr.indexOf('"', colon + 1);
    if (quote !== -1) {
      let i = quote + 1;
      let buf = "";
      while (i < jsonStr.length) {
        const c = jsonStr[i];
        if (c === "\\") {
          const next = jsonStr[i + 1];
          if (next === "n") buf += "\n";
          else if (next === "t") buf += "\t";
          else if (next) buf += next;
          i += 2;
          continue;
        }
        if (c === '"') break;
        buf += c;
        i++;
      }
      if (buf) general_notes = buf;
    }
  }

  return { rows, general_notes };
}

/** Parse trading analysis JSON with fallback for truncated LLM output. */
function parseTradingJson(raw: string): TradingAnalysisResult {
  const jsonStr = extractJsonObject(raw);
  try {
    const parsed = JSON.parse(jsonStr) as { rows?: TradingRow[]; general_notes?: string };
    return { rows: parsed.rows ?? [], general_notes: parsed.general_notes ?? "—" };
  } catch (err) {
    const salvaged = salvageTruncatedTradingJson(jsonStr);
    if (salvaged) {
      console.warn(
        `[analyze] Salvaged ${salvaged.rows.length} rows from truncated JSON:`,
        err instanceof Error ? err.message : err
      );
      return salvaged;
    }
    throw err;
  }
}

const SYSTEM_PROMPT = `אתה אנליסט פיננסי מומחה בתחום המסחר, עם ידע עמוק במתודולוגיה של זיו הקשוריאן (Cycles Trading).
משימתך: לחלץ את כל המידע המסחרי הספציפי לטיקרים מהטרנסקריפט ולהחזיר אותו כ-JSON מובנה.

═══════════════════════════════════════════════════════
⚠️  מילון מונחים בעברית — HEBREW SLANG GUARD (Phase 1)
═══════════════════════════════════════════════════════
ביטויים אלה מתארים כישלון, מלכודת, או הזדמנות שורט — לעולם אל תסמן אותם כאיתות לונג.
אם מונח מהרשימה מופיע בהקשר לטיקר → signal_bias חייב להיות "REJECTED" (לונג) או "SHORT" בלבד.

| מונח עברי               | משמעות אמיתית                        | signal_bias |
|-------------------------|--------------------------------------|-------------|
| פריצת שווא / False Breakout | המחיר פרץ ונפל — מלכודת לקונים   | REJECTED / SHORT |
| מלכודת שווא / Bull Trap  | עלייה מזויפת לפני ירידה חדה          | REJECTED / SHORT |
| מלכודת דובים / Bear Trap | ירידה מזויפת — עשויה להפוך לעלייה   | WATCH (זהירות) |
| איסוף מתוח / Distribution | מכירה בהדרגה ע"י "ידיים חזקות"      | REJECTED / SHORT |
| הפצה / Distribution      | מכירה מסיבית מוסווית בעלייה          | REJECTED / SHORT |
| שיא שווא / Fake High     | שיא שנועד לאסוף סטופים               | REJECTED / SHORT |
| כשל שיא / Top Failure    | המחיר לא מצליח לאשר שיא חדש          | SHORT / WATCH |
| אזור הפצה / Supply Zone  | אזור שבו המוסדיים מוכרים             | REJECTED |
| סטופ קצר / Stop Hunt     | תנועה מכוונת לגרוף סטופים לפני היפוך | WATCH (לא לכניסה) |
| ממש על הסטופ / Knife Catch | קנייה בנפילה חופשית ללא תמיכה       | REJECTED |
| לא נוגע בזה / Avoid      | המנטור מציין שיש להימנע מהנייר       | REJECTED |
| שבור / Broken Structure  | מבנה מחיר שבור — אין תמיכה           | SHORT / REJECTED |
| תמיכה שבורה              | תמיכה קריטית נפרצה כלפי מטה          | SHORT |
| ממתין להבהרה / Wait       | המנטור לא בטוח — מחכה לאישור         | WATCH |
| ספקולטיבי / Speculative   | רמת סיכון גבוהה, לא המלצה אקטיבית   | WATCH |

═══════════════════════════════════════════════════════
📊  שדה mentor_confidence (1–5) — הגדרה קשיחה
═══════════════════════════════════════════════════════
חשב ציון ביטחון על בסיס הקריטריונים הבאים:

5 — טרייד אקטיבי: "נכנסתי", "קניתי", "יש לי פוזיציה", "זה הטרייד שלי"
4 — כוונה נחרצת: "אני עומד להיכנס", "רוצה לקנות ב-X", "ממתין רק למשיכה קטנה ב-X$"
3 — מעקב אקטיבי: "ברשימה שלי", "מעניין אותי", "שומר עין", "יש פוטנציאל"
2 — אזכור אינפורמטיבי: "הוזכר כהקשר", "ראיתי דפוס מעניין", "לא נכנס כרגע"
1 — אזכור שולי/ספקולטיבי: "רעיון היפותטי", "אולי בעתיד", "לא בטוח", "תלוי בשוק"

⚠️  חשוב: אם signal_bias = "REJECTED" — mentor_confidence חייב להיות 1.

═══════════════════════════════════════════════════════
📋  שדות לכל טיקר
═══════════════════════════════════════════════════════
- ticker: סמל המניה או שם הנכס (למשל "TSM", "BKNG", "BTC"). **מניות TASE חייבות סיומת .TA** (למשל "MDTR.TA", לא "MDTR"). מחירי TASE באגורות.
- company: שם החברה המלא. השתמש ב-"—" אם לא ידוע.
- strategy: גישת המסחר לטיקר זה — **בעברית**. היה ספציפי.
- entry_zone: איתות כניסה ספציפי — מחיר, אזור, או תנאי — **בעברית**.
- stop_loss: רמת סטופ לוס — **בעברית**. "—" אם לא הוזכר.
- catalyst: הסיבה/היגיון מאחורי העסקה — **בעברית**.
- tradingview_alert: האם הוגדרה התראה ב-TradingView — **בעברית**.
- watchlist: האם הוסף לרשימת מעקב — **בעברית**.
- mentor_confidence: ציון 1–5 לפי ההגדרה לעיל.
- signal_bias: "LONG" / "SHORT" / "WATCH" / "REJECTED" לפי מילון המונחים לעיל.

ספק גם "general_notes" המסכמת תצפיות שוק כלליות — **בעברית**.

כללים חשובים:
- שורה אחת לכל טיקר בלבד.
- כלול את כל הטיקרים שהוזכרו, אפילו בקצרה.
- אם signal_bias = "REJECTED" — mentor_confidence = 1 בהכרח.
- אל תסמן שום ביטוי שלילי (פריצת שווא, מלכודת, הפצה) כ-LONG — גם אם מופיעות מילות "פריצה" או "עלייה" בסמוך.
- החזר אך ורק אובייקט JSON: { "rows": [...], "general_notes": "..." }

אם לא נמצאו טיקרים, החזר { "rows": [], "general_notes": "לא הוזכרו טיקרים ספציפיים." }.`;

/** Analyze a text transcript using the LLM */
export async function analyzeTranscript(transcript: string): Promise<{ rows: TradingRow[]; general_notes: string }> {
  const response = await invokeLLM({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this video transcript and extract all trading information:\n\n${transcript.slice(0, 14000)}`,
      },
    ],
    response_format: TRADING_JSON_SCHEMA,
  });

  const rawContent = response.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : null;
  if (!content) throw new Error("AI returned empty response");

  return parseTradingJson(content);
}

/**
 * Fallback 3: Analyze a YouTube video directly using the LLM's native video understanding.
 * Gemini 2.5 Flash can process YouTube URLs as file_url content — no transcript needed.
 * Used when both YouTube captions and Supadata are unavailable.
 */
export async function analyzeVideoDirectly(videoUrl: string): Promise<{ rows: TradingRow[]; general_notes: string }> {
  // NOTE: response_format (json_schema) is NOT supported when using file_url multimodal input.
  // Instead we instruct the model explicitly to return JSON and extract it from the plain text response.
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          "\n\nCRITICAL: Your entire response MUST be a single valid JSON object. Do NOT include any markdown code fences, explanations, or text outside the JSON. Start your response with { and end with }.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Watch this trading video carefully. The video may be in Hebrew or English — analyze it fully regardless of language. Extract ALL ticker-specific trading information and return ONLY a JSON object in this exact format: {"rows": [...], "general_notes": "..."}',
          },
          {
            type: "file_url",
            file_url: {
              url: videoUrl,
              mime_type: "video/mp4",
            },
          },
        ],
      },
    ],
    // No response_format here — not compatible with multimodal file_url input
  });

  const rawContent = response.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent.trim() : null;
  if (!content) throw new Error("AI returned empty response during direct video analysis");

  // Guard: if the model returned HTML (e.g. an error page), throw a clear error
  if (content.startsWith("<")) {
    throw new Error("Direct video analysis failed: received an unexpected HTML response from the AI service. Please try again.");
  }

  // Extract JSON from the response — handles cases where the model wraps it in markdown fences
  return parseTradingJson(content);
}

/**
 * Analyze a YouTube video directly using Gemini 2.5 Flash via REST API.
 * Used as fallback when Supadata transcript is unavailable (live streams, disabled captions).
 * Does NOT require a transcript — Gemini watches the video natively.
 */
export async function analyzeVideoWithGemini(videoUrl: string): Promise<{ rows: TradingRow[]; general_notes: string }> {
  const apiKey = ENV.geminiApiKey;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const prompt = `You are an expert financial trading analyst specializing in Ziv Hekusharian (Cycles Trading) methodology.
Watch this trading video carefully. It may be in Hebrew or English — analyze it fully regardless of language.
Extract ALL ticker-specific trading information and return ONLY a valid JSON object in this exact format:
{"rows": [{"ticker":"...","company":"...","strategy":"...","entry_zone":"...","stop_loss":"...","catalyst":"...","tradingview_alert":"...","watchlist":"...","mentor_confidence":3,"signal_bias":"WATCH"}], "general_notes": "..."}

signal_bias values: LONG | SHORT | WATCH | REJECTED
mentor_confidence: 1-5 (1=rejected/noise, 2=low, 3=moderate, 4=high, 5=very high)
If a ticker is mentioned as risky/avoid/bad → signal_bias=REJECTED, confidence=1
Israeli TASE stocks MUST use .TA suffix in ticker field (e.g. MDTR.TA not MDTR). TASE prices are in agorot in entry_zone.
Return ONLY the JSON object. No markdown, no explanation.`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  // Gemini 2.0 Flash: YouTube URLs passed via video_metadata (not file_data)
  const body = {
    contents: [
      {
        parts: [
          {
            file_data: {
              mime_type: "video/*",
              file_uri: videoUrl,
            },
          },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 240_000);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 120)}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!rawText) throw new Error("Gemini returned empty response");

  const finishReason = data.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    console.warn("[analyze] Gemini response truncated (MAX_TOKENS) — attempting JSON salvage");
  }

  return parseTradingJson(rawText);
}

/** Fetch transcript via Supadata API (fallback when YouTube captions are disabled) */
async function fetchTranscriptViaSupadata(videoId: string): Promise<string | null> {
  const apiKey = ENV.supadataApiKey;
  if (!apiKey) return null;

  // All language variants tried IN PARALLEL — first successful result wins.
  // Each individual request has a 12s timeout via manual AbortController.
  // The whole block is capped at 20s by the outer Promise.race.
  const urls = [
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true&lang=iw`,
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true&lang=he`,
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true&lang=en`,
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true&lang=ar`,
  ];

  const headers = { "x-api-key": apiKey };

  /** Try a single URL and resolve with the transcript string, or null on failure */
  async function tryOne(url: string): Promise<string | null> {
    try {
      const res = await fetchWithTimeout(url, { headers }, 12_000);
      if (!res.ok) return null;
      const data = (await res.json()) as { content?: string; segments?: Array<{ text: string }>; error?: string };
      if (data.error) return null;
      if (data.content && typeof data.content === "string" && data.content.length > 50) return data.content;
      if (Array.isArray(data.segments) && data.segments.length > 0) return data.segments.map((s) => s.text).join(" ");
      return null;
    } catch {
      return null;
    }
  }

  // Race all requests in parallel; resolve with first non-null result.
  // Overall cap: 20s — if all requests fail/timeout within that window, return null.
  const outerTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000));

  const parallelRace = new Promise<string | null>((resolve) => {
    let pending = urls.length;
    let resolved = false;
    for (const url of urls) {
      tryOne(url).then((result) => {
        if (result && !resolved) {
          resolved = true;
          resolve(result);
        } else {
          pending--;
          if (pending === 0 && !resolved) resolve(null);
        }
      });
    }
  });

  return Promise.race([parallelRace, outerTimeout]);
}

// ─── Router ─────────────────────────────────────────────────────────────────

export const analyzeRouter = router({
  /** Start a new analysis — creates DB record and runs the full pipeline */
  start: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input, ctx }) => {
      const videoId = extractVideoId(input.url);
      if (!videoId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid YouTube URL. Please provide a valid YouTube video link.",
        });
      }

      // Create initial DB record
      const analysisId = await createAnalysis({
        userId: ctx.user.id,
        videoUrl: input.url,
        videoId,
        status: "processing",
      });

      // Run pipeline asynchronously — client polls for status
      // Hard 240s deadline: long videos analyzed via direct AI path can take 90-180s
      withTimeout(runPipeline(analysisId, videoId, input.url, ctx.user.id), 240_000, "pipeline").catch(async (err) => {
        await updateAnalysis(analysisId, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });

      return { analysisId };
    }),

  /** Poll the current status of an analysis */
  status: protectedProcedure
    .input(z.object({ analysisId: z.number() }))
    .query(async ({ input, ctx }) => {
      const analysis = await getAnalysisById(input.analysisId);
      if (!analysis || analysis.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Analysis not found." });
      }
      return analysis;
    }),

  /** Get analysis history for the current user */
  history: protectedProcedure.query(async ({ ctx }) => {
    return getAnalysesByUser(ctx.user.id, 20);
  }),

  /** Public: validate a YouTube URL and extract video ID */
  validateUrl: publicProcedure
    .input(z.object({ url: z.string() }))
    .query(({ input }) => {
      const videoId = extractVideoId(input.url);
      return { valid: !!videoId, videoId };
    }),

  /** Start a bulk analysis of up to 10 YouTube URLs */
  startBulk: protectedProcedure
    .input(
      z.object({
        urls: z
          .array(z.string().url())
          .min(1, "At least 1 URL required")
          .max(10, "Maximum 10 URLs allowed"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Validate all URLs first
      const videoIds: string[] = [];
      for (const url of input.urls) {
        const id = extractVideoId(url);
        if (!id) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid YouTube URL: ${url}`,
          });
        }
        videoIds.push(id);
      }

      // Create bulk session
      const bulkSessionId = await createBulkSession(ctx.user.id, input.urls.length);

      // Create individual analysis records
      const analysisIds: number[] = [];
      for (let i = 0; i < input.urls.length; i++) {
        const analysisId = await createAnalysis({
          userId: ctx.user.id,
          videoUrl: input.urls[i],
          videoId: videoIds[i],
          status: "pending",
        });
        await linkAnalysisToBulkSession(bulkSessionId, analysisId, i);
        analysisIds.push(analysisId);
      }

      // Run pipelines sequentially in the background
      runBulkPipeline(bulkSessionId, analysisIds, videoIds, input.urls, ctx.user.id).catch(
        async (err) => {
          console.error("[Bulk] Pipeline error:", err);
          await updateBulkSession(bulkSessionId, { status: "done" });
        }
      );

      return { bulkSessionId, analysisIds };
    }),

  /** Poll the status of a bulk session */
  bulkStatus: protectedProcedure
    .input(z.object({ bulkSessionId: z.number() }))
    .query(async ({ input, ctx }) => {
      const result = await getBulkSessionWithAnalyses(input.bulkSessionId);
      if (!result || result.session.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bulk session not found." });
      }
      return result;
    }),

  /** Get bulk session history for the current user */
  bulkHistory: protectedProcedure.query(async ({ ctx }) => {
    return getBulkSessionsByUser(ctx.user.id, 10);
  }),
});

// ─── Background pipeline ─────────────────────────────────────────────────────

/**
 * Progress step codes — stored in errorMessage field during processing.
 * Format: "progress:STAGE_CODE:PERCENTAGE:ACTION_TEXT"
 * This field is repurposed as a progress channel while status === "processing".
 */
function progressCode(stage: string, pct: number, action: string): string {
  return `progress:${stage}:${pct}:${action}`;
}

/**
 * Wrap a promise with a hard deadline. Rejects with a descriptive error if
 * the pipeline takes longer than `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Analysis timed out after ${Math.round(ms / 1000)}s during: ${label}`)),
      ms
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export async function runPipeline(analysisId: number, videoId: string, videoUrl: string, userId: number) {
  // ── STAGE 1: Data Acquisition (0–20%) ────────────────────────────────────
  await updateAnalysis(analysisId, {
    status: "processing",
    errorMessage: progressCode("stage1", 0, "Initializing connection to YouTube..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage1", 8, "Extracting raw video metadata..."),
  });
  const meta = await fetchYouTubeMetadata(videoId);
  // Fetch the original video publish date — this is the canonical signal date
  const publishDate = await fetchVideoPublishDate(videoId);
  if (meta || publishDate) {
    await updateAnalysis(analysisId, {
      videoTitle: meta?.title ?? undefined,
      channelName: meta?.channelName ?? undefined,
      thumbnailUrl: meta?.thumbnailUrl ?? undefined,
      // Store publish date immediately so autoMergeMasterSignals can use it
      ...(publishDate ? { publishDate } : {}),
    });
  }

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage1", 15, "Locating caption tracks and subtitle streams..."),
  });
  const captionText = await tryFetchCaptions(videoId);

  let transcript: string;
  let analysisResult: { rows: TradingRow[]; general_notes: string };

  if (captionText) {
    transcript = captionText;
    await updateAnalysis(analysisId, {
      transcript,
      errorMessage: progressCode("stage1", 20, "Transcript acquired via YouTube captions."),
    });
  } else {
    // Fallback 2: Supadata API
    await updateAnalysis(analysisId, {
      errorMessage: progressCode("stage1", 17, "Captions unavailable — activating Supadata fallback..."),
    });
    const supadataTranscript = await fetchTranscriptViaSupadata(videoId);

    if (supadataTranscript) {
      transcript = supadataTranscript;
      await updateAnalysis(analysisId, {
        transcript,
        errorMessage: progressCode("stage1", 20, "Transcript acquired via Supadata API."),
      });
    } else {
      // Fallback 3: Direct video analysis via LLM (Gemini 2.5 Flash supports YouTube URLs natively)
      await updateAnalysis(analysisId, {
        errorMessage: progressCode("stage1", 19, "Supadata unavailable — activating direct video AI analysis..."),
      });

      // Skip the normal transcript+analysis flow; run combined video analysis directly
      await updateAnalysis(analysisId, {
        errorMessage: progressCode("stage2", 22, "Uploading video to AI engine — this may take 1-3 minutes for long videos..."),
      });

      // Emit a "still working" update every 30s so the frontend stale timer resets
      const heartbeatInterval = setInterval(async () => {
        await updateAnalysis(analysisId, {
          errorMessage: progressCode("stage2", 25, "AI is watching and transcribing the video... Please wait."),
        }).catch(() => {});
      }, 30_000);

      let directResult: { rows: TradingRow[]; general_notes: string };
      try {
        // v19.5: Gemini direct video analysis (watches YouTube natively, no transcript needed)
        if (ENV.geminiApiKey) {
          directResult = await analyzeVideoWithGemini(videoUrl);
        } else {
          directResult = await analyzeVideoDirectly(videoUrl);
        }
      } finally {
        clearInterval(heartbeatInterval);
      }

      await updateAnalysis(analysisId, {
        errorMessage: progressCode("stage3", 70, `Direct video analysis complete — ${directResult.rows.length} signals identified.`),
      });

      // Jump straight to stage 4 (skip transcript-based stages)
      await updateAnalysis(analysisId, {
        errorMessage: progressCode("stage4", 71, "Updating internal Knowledge Matrix (15 Topics)..."),
      });
      await updateAnalysis(analysisId, {
        errorMessage: progressCode("stage4", 85, "Adjusting proficiency levels based on new data..."),
      });
      await updateAnalysis(analysisId, {
        errorMessage: progressCode("stage5", 91, "Compiling Professional Trade Cards..."),
      });
      await updateAnalysis(analysisId, {
        analysisResult: JSON.stringify(directResult),
        status: "done",
        errorMessage: null,
      });
      return; // Early exit — pipeline complete via direct video path
    }
  }

  // ── STAGE 2: Technical Filtering (21–40%) ────────────────────────────────
  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage2", 21, "Scanning transcript for Technical Indicators (MA, RSI, Bollinger)..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage2", 28, "Identifying Tickers and asset symbols..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage2", 35, "Mapping entry zones and price levels..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage2", 40, "Technical filtering complete — passing to synthesis engine."),
  });

  // ── STAGE 3: Logic Synthesis (41–70%) ────────────────────────────────────
  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage3", 41, "Analyzing Support and Resistance zones..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage3", 50, "Correlating Fundamental Catalysts with Price Action..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage3", 58, "Extracting Stop-Loss levels and risk parameters..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage3", 65, "Running AI synthesis — building trade signal map..."),
  });

  // Run the actual AI analysis
  analysisResult = await analyzeTranscript(transcript);

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage3", 70, `Logic synthesis complete — ${analysisResult.rows.length} signals identified.`),
  });

  // ── STAGE 4: Knowledge Update (71–90%) ───────────────────────────────────
  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage4", 71, "Updating internal Knowledge Matrix (15 Topics)..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage4", 80, "Adjusting proficiency levels based on new data..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage4", 88, "Calibrating pattern recognition weights..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage4", 90, "Knowledge Matrix updated successfully."),
  });

  // ── STAGE 5: Final Delivery (91–100%) ────────────────────────────────────
  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage5", 91, "Compiling Professional Trade Cards..."),
  });

  await updateAnalysis(analysisId, {
    errorMessage: progressCode("stage5", 96, "Finalizing report for the Customer..."),
  });

  await updateAnalysis(analysisId, {
    analysisResult: JSON.stringify(analysisResult),
    status: "done",
    errorMessage: null,
  });

  // Auto-merge new signals into the Master Knowledge JSON (background, non-blocking)
  autoMergeMasterSignals(userId, analysisId, analysisResult.rows).catch((err: unknown) =>
    console.error("[Master JSON] Auto-merge failed:", err)
  );

  // Auto-update proficiency matrix from this analysis (background, non-blocking)
  autoUpdateProficiency(userId, analysisId).catch((err: unknown) =>
    console.error("[Proficiency] Auto-update failed:", err)
  );

  // Auto-regenerate Knowledge Base + Master JSON after proficiency update settles (background)
  setTimeout(() => {
    autoRegenAll(userId).catch((err: unknown) =>
      console.error("[AutoRegen] Failed:", err)
    );
  }, 5000); // 5s delay so proficiency update finishes first
}

// ─── Proficiency auto-update ─────────────────────────────────────────────────

/**
 * Automatically updates the proficiency matrix after each analysis completes.
 * Extracts dynamic topics from the video and updates levels in the background.
 */
async function autoUpdateProficiency(userId: number, analysisId: number): Promise<void> {
  const { getAnalysisById, getProficiencyMatrixByUser, bulkUpsertProficiency } = await import("../db");
  const { invokeLLM } = await import("../_core/llm");

  const analysis = await getAnalysisById(analysisId);
  if (!analysis || !analysis.analysisResult) return;

  const currentRows = await getProficiencyMatrixByUser(userId);
  const currentMatrix: Record<string, number> = {};
  for (const row of currentRows) {
    currentMatrix[row.topic] = row.level;
  }

  const existingTopics = Object.entries(currentMatrix)
    .map(([t, l]) => `  "${t}": ${l}/10`)
    .join("\n") || "  (none yet — this is the first video analyzed)";

  const systemPrompt = `You are an AI trading analyst that builds a dynamic knowledge proficiency matrix from YouTube trading videos.

Your job is to EXTRACT real topics from the video content — do NOT use a fixed list. Topics should reflect the actual methodology, strategies, and concepts discussed in THIS specific video.

CURRENT KNOWLEDGE MATRIX (topics learned so far):
${existingTopics}

Instructions:
1. Read the video content carefully
2. Identify EVERY distinct trading concept, strategy, or methodology discussed
3. For each concept found:
   - Create a clear, specific topic title (e.g. "Gann Cycle Timing", "Kiss & Go Entry Pattern", "Weekly Low Stop-Loss Rule")
   - If this topic already exists in the current matrix, UPDATE its level
   - If this is a NEW topic not in the matrix, ADD it with a starting level based on how deeply it was covered
   - Write a knowledgeSummary: a 1-sentence definition of this concept as taught in this methodology
   - Write an insight: what specifically was learned from THIS video

Rules:
- Levels range from 1 (novice) to 10 (expert)
- New topics start at level 2-4 depending on depth of coverage
- Maximum increase per video for existing topics is +2
- Be SPECIFIC: "RSI" is too vague — use "RSI Overbought/Oversold Signals" or "RSI Divergence Detection"
- Topics must come from the actual video content — never invent topics not discussed

Return a JSON object:
{
  "updates": [
    {
      "topic": "Gann Cycle Timing",
      "currentLevel": 0,
      "newLevel": 3,
      "knowledgeSummary": "A time-based cycle theory where market turns are predicted at specific intervals.",
      "insight": "The analyst uses 90-day Gann cycles to predict reversal windows."
    }
  ]
}`;

  let tradingRows: Array<Record<string, string>> = [];
  try {
    const parsed = JSON.parse(analysis.analysisResult);
    tradingRows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
  } catch { /* ignore */ }

  const videoTitle = analysis.videoTitle ?? "Unknown Video";
  const userContent = `Video: "${videoTitle}"\n\nTrading signals extracted:\n${JSON.stringify(tradingRows, null, 2)}\n\nTranscript excerpt:\n${(analysis.transcript ?? "").slice(0, 3000)}`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "proficiency_update",
        strict: true,
        schema: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  topic: { type: "string" },
                  currentLevel: { type: "integer" },
                  newLevel: { type: "integer" },
                  insight: { type: "string" },
                  knowledgeSummary: { type: "string" },
                },
                required: ["topic", "currentLevel", "newLevel", "insight", "knowledgeSummary"],
                additionalProperties: false,
              },
            },
          },
          required: ["updates"],
          additionalProperties: false,
        },
      },
    },
  });

  const rawContent = response.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : null;
  if (!content) return;

  let updates: Array<{ topic: string; currentLevel: number; newLevel: number; insight: string; knowledgeSummary: string }> = [];
  try {
    const parsed = JSON.parse(content);
    updates = parsed.updates ?? [];
  } catch { return; }

  const validUpdates = updates.filter((u) =>
    typeof u.topic === "string" && u.topic.trim().length > 0 &&
    u.newLevel >= 1 && u.newLevel <= 10
  );

  if (validUpdates.length === 0) return;

  await bulkUpsertProficiency(
    userId,
    validUpdates.map((u) => ({
      topic: u.topic.trim(),
      newLevel: Math.min(10, Math.max(1, u.newLevel)),
      logEntry: {
        videoTitle,
        insight: u.insight,
        knowledgeSummary: u.knowledgeSummary ?? "",
        levelBefore: currentMatrix[u.topic] ?? 0,
        levelAfter: Math.min(10, Math.max(1, u.newLevel)),
        date: new Date().toISOString(),
      },
    }))
  );

  console.log(`[Proficiency] Auto-updated ${validUpdates.length} topics for user ${userId} from analysis ${analysisId}`);
}
// ─── Auto-regen all (KB + Master JSON) ───────────────────────────────────────────────────────

async function autoRegenAll(userId: number): Promise<void> {
  const { autoRegenerateKnowledgeBase } = await import("./knowledgeBase");
  const { autoRegenerateMasterKnowledge } = await import("./masterKnowledge");
  // Run sequentially: KB first, then Master JSON (which uses KB context)
  await autoRegenerateKnowledgeBase(userId);
  await autoRegenerateMasterKnowledge(userId);
}

// ─── Master Knowledge auto-merge ────────────────────────────────────────────

/**
 * Merges new trading signals from a completed analysis into the user's Master Knowledge JSON.
 * Runs in the background after each analysis completes — non-blocking.
 */
async function autoMergeMasterSignals(
  userId: number,
  analysisId: number,
  newRows: Array<{ ticker?: string; company?: string; entry_zone?: string; stop_loss?: string; catalyst?: string }>
): Promise<void> {
  if (!newRows || newRows.length === 0) return;
  // Get analysis metadata
  const analysis = await getAnalysisById(analysisId);
  const videoTitle = analysis?.videoTitle ?? "Auto-merged from analysis";
  const videoId = analysis?.videoId ?? "";

  // Use video publish date as the signal date — NEVER the analysis date
  // Priority: analysis.publishDate (set during pipeline) → channelVideos.uploadDate → null (signal date left blank)
  let signalDate: string | null = null;

  // Priority 1: publishDate stored directly on the analysis record
  if (analysis?.publishDate) {
    signalDate = new Date(analysis.publishDate).toISOString().split("T")[0];
  }

  // Priority 2: channelVideos table (video was synced from channel page)
  if (!signalDate && videoId) {
    try {
      const channelVideo = await getChannelVideoByVideoId(videoId);
      if (channelVideo?.uploadDate) {
        signalDate = new Date(channelVideo.uploadDate).toISOString().split("T")[0];
      }
    } catch {
      // fall through
    }
  }

  // Priority 3: Fetch from Supadata/channelVideos in real-time as last resort
  if (!signalDate && videoId) {
    try {
      const fetchedDate = await fetchVideoPublishDate(videoId);
      if (fetchedDate) {
        signalDate = fetchedDate.toISOString().split("T")[0];
        // Persist it so future calls don't need to re-fetch
        await updateAnalysis(analysisId, { publishDate: fetchedDate });
      }
    } catch {
      // fall through
    }
  }

  // If we still have no publish date, leave signalDate as null — do NOT use today's date

  // Determine mentor from channel name stored in analysis
  const channelName = (analysis?.channelName ?? "").toLowerCase();
  const mentor = channelName.includes("micha") ? "micha_stocks" : "cycles_trading";

  const mk = await getMasterKnowledgeByUser(userId);
  const existingSignals: Array<{
    ticker: string; company: string; entry: string;
    stopLoss: string; takeProfit: string; catalyst: string;
    status: string; source: string; signalDate?: string; mentor?: string;
  }> = mk?.activeSignals ? JSON.parse(mk.activeSignals) : [];
  const signalMap = new Map(existingSignals.map((s) => [s.ticker.toUpperCase(), s]));
  for (const row of newRows) {
    const ticker = (row.ticker ?? "").toUpperCase().trim();
    if (!ticker || ticker === "N/A" || ticker === "-" || ticker.length > 10) continue;
    const existing = signalMap.get(ticker);
    signalMap.set(ticker, {
      ticker,
      company: row.company ?? "",
      entry: row.entry_zone ?? "—",
      stopLoss: row.stop_loss ?? "—",
      takeProfit: "—",
      catalyst: row.catalyst ?? "—",
      status: "watch",
      source: videoTitle,
      // Preserve original signal date if already set (never overwrite with a newer date)
      signalDate: existing?.signalDate ?? signalDate ?? undefined,
      mentor: existing?.mentor ?? mentor,
    });
  }
  await upsertMasterKnowledge(userId, {
    activeSignals: JSON.stringify(Array.from(signalMap.values())),
  });
}

// ─── Bulk pipeline ────────────────────────────────────────────────────────────

async function runBulkPipeline(
  bulkSessionId: number,
  analysisIds: number[],
  videoIds: string[],
  videoUrls: string[],
  _userId: number
) {
  await updateBulkSession(bulkSessionId, { status: "processing" });

  let doneCount = 0;
  let errorCount = 0;

  for (let i = 0; i < analysisIds.length; i++) {
    const analysisId = analysisIds[i];
    const videoId = videoIds[i];
    const videoUrl = videoUrls[i];

    try {
      // Mark this individual analysis as processing
      await updateAnalysis(analysisId, { status: "processing" });
      // Hard 120s deadline per video in bulk mode
      await withTimeout(runPipeline(analysisId, videoId, videoUrl, _userId), 120_000, "pipeline");
      doneCount++;
    } catch (err: unknown) {
      errorCount++;
      await updateAnalysis(analysisId, {
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    // Update session progress after each video
    await updateBulkSession(bulkSessionId, {
      doneCount,
      errorCount,
      status: i === analysisIds.length - 1 ? "done" : "processing",
    });
  }
}

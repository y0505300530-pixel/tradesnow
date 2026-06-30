
import { createAnalysis, markChannelVideoAnalyzed, updateAnalysis } from "../server/db.js";
import { analyzeTranscript, analyzeVideoWithGemini } from "../server/routers/analyze.js";
import * as mysql2 from "mysql2/promise";
import * as dotenv from "dotenv";

dotenv.config({ path: "/root/tradesnow/.env" });

const DB_CONFIG = {
  host: "127.0.0.1",
  user: "tradesnow",
  password: "TsV2026_LocalDb",
  database: "tradesnow",
  charset: "utf8mb4" as const,
};

const OWNER_USER_ID = 1;
const DELAY_MS = 2000;     // between videos
const GEMINI_DELAY_MS = 4000; // extra delay after Gemini calls (rate limit)

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchTranscript(videoId: string): Promise<string | null> {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) return null;
  const langs = ["", "&lang=iw", "&lang=he", "&lang=en"];
  for (const lang of langs) {
    try {
      const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true${lang}`;
      const r = await fetch(url, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) continue;
      const d = await r.json() as any;
      if (d?.content && d.content.length > 50) return d.content;
    } catch { continue; }
  }
  return null;
}

async function main() {
  // Accept optional --gemini-only flag to only process no-transcript videos
  const geminiOnly = process.argv.includes("--gemini-only");
  const conn = await (mysql2 as any).createConnection(DB_CONFIG);

  const query = geminiOnly
    ? "SELECT id, videoId, mentor, title, uploadDate FROM channelVideos WHERE uploadDate >= '2026-04-01' AND analyzedAt IS NULL ORDER BY uploadDate ASC"
    : "SELECT id, videoId, mentor, title, uploadDate FROM channelVideos WHERE uploadDate >= '2026-04-01' AND analyzedAt IS NULL ORDER BY uploadDate ASC";

  const [rows] = await conn.execute(query) as any[];

  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  console.log(`\n🎬 Found ${rows.length} unanalyzed videos`);
  console.log(`🔑 Gemini: ${geminiKey ? "✅ configured" : "❌ not configured"}`);
  console.log(`📋 Mode: ${geminiOnly ? "Gemini-only fallback" : "Full pipeline (Supadata → Gemini)"}\n`);

  let done = 0, failedSupadata = 0, usedGemini = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const video = rows[i];
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    const label = String(video.title).slice(0, 50);
    process.stdout.write(`[${i+1}/${rows.length}] ${label}... `);

    try {
      // 1. Create analysis record
      const analysisId = await createAnalysis({
        userId: OWNER_USER_ID,
        videoUrl,
        videoId: video.videoId,
        status: "processing",
      });

      // 2. Try Supadata transcript first
      const transcript = await fetchTranscript(video.videoId);

      let result: { rows: any[]; general_notes: string };
      let method = "";

      if (!geminiOnly && transcript) {
        // Fast path: LLM on transcript text (only in full mode)
        await updateAnalysis(analysisId, { transcript, status: "processing" });
        result = await analyzeTranscript(transcript);
        method = "📝 supadata";
      } else if (geminiKey) {
        // Gemini direct video analysis — no transcript needed
        process.stdout.write("[gemini] ");
        result = await Promise.race([
          analyzeVideoWithGemini(videoUrl),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("gemini timeout 150s")), 150_000))
        ]);
        method = "🎥 gemini";
        usedGemini++;
        await sleep(GEMINI_DELAY_MS); // extra delay for Gemini rate limit
      } else {
        failedSupadata++;
        await updateAnalysis(analysisId, { status: "error", errorMessage: "No transcript — GEMINI_API_KEY not set" });
        console.log(`⚠️  no transcript, no gemini key`);
        continue;
      }

      // 3. Save result
      await updateAnalysis(analysisId, {
        analysisResult: JSON.stringify(result),
        status: "done",
        errorMessage: null,
      });
      await markChannelVideoAnalyzed(video.videoId, analysisId);
      done++;
      console.log(`✅ ${result.rows?.length ?? 0} tickers [${method}]`);

    } catch (e: any) {
      failed++;
      console.log(`❌ ${(e.message ?? String(e)).slice(0, 70)}`);
    }

    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  await conn.end();
  console.log(`\n${"=".repeat(55)}`);
  console.log(`✅ Analyzed: ${done} (Gemini: ${usedGemini})`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⚠️  No transcript/key: ${failedSupadata}`);
  console.log(`Total: ${rows.length}`);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});


import { runPipeline, createAnalysis, markChannelVideoAnalyzed } from "/root/tradesnow/dist/index.js";
import mysql from "mysql2/promise";
import * as fs from "fs";
import * as path from "path";

// Load .env
const envPath = "/root/tradesnow/.env";
const envLines = fs.readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const DB_CONFIG = {
  host: "127.0.0.1",
  user: "tradesnow",
  password: "TsV2026_LocalDb",
  database: "tradesnow",
  charset: "utf8mb4"
};

const OWNER_USER_ID = 1;
const DELAY_MS = 3000; // 3 second delay between videos to avoid rate limits

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);

  // Get all unanalyzed videos from 1.4.2026
  const [rows] = await conn.execute(
    "SELECT id, videoId, mentor, title, uploadDate FROM channelVideos WHERE uploadDate >= '2026-04-01' AND analyzedAt IS NULL ORDER BY uploadDate ASC"
  );

  console.log(`Found ${rows.length} unanalyzed videos from 2026-04-01`);
  
  let done = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const video = rows[i];
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    console.log(`\n[${i+1}/${rows.length}] ${video.mentor} | ${video.title.slice(0,50)} | ${video.videoId}`);

    try {
      const analysisId = await createAnalysis({
        userId: OWNER_USER_ID,
        videoUrl,
        videoId: video.videoId,
        status: "processing",
      });

      await Promise.race([
        runPipeline(analysisId, video.videoId, videoUrl, OWNER_USER_ID),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 180_000))
      ]);

      await markChannelVideoAnalyzed(video.videoId, analysisId);
      done++;
      console.log(`  ✅ Done (analysisId=${analysisId})`);
    } catch (e) {
      failed++;
      console.error(`  ❌ Failed: ${e.message?.slice(0, 80)}`);
    }

    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  await conn.end();
  console.log(`\n=== COMPLETE: ${done} analyzed, ${failed} failed ===`);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});

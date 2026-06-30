/**
 * One-off batch: upsert catalog video IDs + run analyze pipeline.
 * Usage: node --import tsx scripts/run_user_video_batch.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: "/root/tradesnow/.env" });

import {
  createAnalysis,
  markChannelVideoAnalyzed,
  updateAnalysis,
  upsertChannelVideos,
  getChannelVideoByVideoId,
} from "../server/db.js";
import { runPipeline } from "../server/routers/analyze.js";
import mysql from "mysql2/promise";

const OWNER_USER_ID = 1;
const VIDEO_IDS = [
  ...new Set([
    "YoO8PLC4xTs", "FwQgQvb9QlU", "eTVqiCxolTY", "3iqhYB8VNz0", "BxU463WI14M",
    "zg-vZyQpGnM", "m8e1q4pnXVs", "G89tl2hjJQs", "ZeT5NIR8a-g", "paOvSBYcH6M",
    "zryV1uyM-jg", "PEe_L73vGMI", "nI37JAmj9Eg", "dxgKTSxk3rY", "lx_6phsV_qA", "F8-Hi9wYxSs",
  ]),
];

const DELAY_MS = 3000;
const GEMINI_EXTRA_MS = 5000;

type RowStatus = {
  videoId: string;
  inChannelVideos: boolean;
  priorAnalysis: string;
  action: string;
  finalStatus: string;
  rowCount: number | null;
  method: string;
  error: string | null;
};

async function fetchOembed(videoId: string) {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return { title: `Video ${videoId}`, channelName: null as string | null };
  const d = (await res.json()) as { title?: string; author_name?: string };
  return { title: d.title ?? `Video ${videoId}`, channelName: d.author_name ?? null };
}

async function latestAnalysisStatus(conn: mysql.Connection, videoId: string) {
  const [rows] = await conn.execute(
    `SELECT id, status, errorMessage, analysisResult IS NOT NULL AS hasResult
     FROM analyses WHERE videoId = ? ORDER BY id DESC LIMIT 1`,
    [videoId]
  );
  const r = (rows as any[])[0];
  if (!r) return { id: null as number | null, status: "none", hasResult: false, errorMessage: null as string | null };
  return { id: r.id as number, status: r.status as string, hasResult: !!r.hasResult, errorMessage: r.errorMessage as string | null };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL missing");
  const conn = await mysql.createConnection(dbUrl);
  const results: RowStatus[] = [];

  for (const videoId of VIDEO_IDS) {
    const row: RowStatus = {
      videoId,
      inChannelVideos: false,
      priorAnalysis: "none",
      action: "pending",
      finalStatus: "pending",
      rowCount: null,
      method: "",
      error: null,
    };

    try {
      let cv = await getChannelVideoByVideoId(videoId);
      row.inChannelVideos = !!cv;
      if (!cv) {
        const meta = await fetchOembed(videoId);
        await upsertChannelVideos([
          {
            videoId,
            mentor: "cycles_trading",
            title: meta.title,
            uploadDate: new Date("2020-01-01"),
            thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            isNew: 0,
          },
        ]);
        cv = await getChannelVideoByVideoId(videoId);
        row.inChannelVideos = !!cv;
      }

      const prior = await latestAnalysisStatus(conn, videoId);
      row.priorAnalysis = prior.status;
      if (prior.status === "done" && prior.hasResult) {
        row.action = "skipped";
        row.finalStatus = "done";
        row.method = "existing";
        const [ar] = await conn.execute(
          "SELECT JSON_LENGTH(JSON_EXTRACT(analysisResult, '$.rows')) AS rc FROM analyses WHERE id = ?",
          [prior.id]
        );
        row.rowCount = Number((ar as any[])[0]?.rc ?? 0);
        results.push(row);
        console.log(JSON.stringify({ event: "skip", ...row }));
        continue;
      }

      const analysisId = await createAnalysis({
        userId: OWNER_USER_ID,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        status: "processing",
      });
      row.action = prior.status === "error" ? "re-analyze" : "analyze";

      await runPipeline(analysisId, videoId, `https://www.youtube.com/watch?v=${videoId}`, OWNER_USER_ID);
      await markChannelVideoAnalyzed(videoId, analysisId);

      const after = await latestAnalysisStatus(conn, videoId);
      row.finalStatus = after.status;
      if (after.status === "done") {
        const [ar] = await conn.execute(
          "SELECT JSON_LENGTH(JSON_EXTRACT(analysisResult, '$.rows')) AS rc, transcript IS NOT NULL AS hasTx FROM analyses WHERE id = ?",
          [analysisId]
        );
        const info = (ar as any[])[0];
        row.rowCount = Number(info?.rc ?? 0);
        row.method = info?.hasTx ? "transcript+llm" : "gemini-direct";
      } else {
        row.error = after.errorMessage;
        row.method = "failed";
      }
    } catch (e: any) {
      row.finalStatus = "error";
      row.error = (e?.message ?? String(e)).slice(0, 300);
      row.method = "exception";
    }

    results.push(row);
    console.log(JSON.stringify({ event: "done", ...row }));
    await sleep(DELAY_MS + (row.method.includes("gemini") ? GEMINI_EXTRA_MS : 0));
  }

  await conn.end();
  console.log("===SUMMARY===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

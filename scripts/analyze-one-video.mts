import "dotenv/config";
import { runPipeline } from "../server/routers/analyze.ts";

const analysisId = Number(process.argv[2] ?? "810289");
const videoId = process.argv[3] ?? "dyxOZJvr0zk";
const userId = Number(process.argv[4] ?? "1");
const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

runPipeline(analysisId, videoId, videoUrl, userId)
  .then(() => {
    console.log("Pipeline complete:", analysisId, videoId);
  })
  .catch((err: unknown) => {
    console.error("Pipeline failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

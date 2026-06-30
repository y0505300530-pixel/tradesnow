
import { createAnalysis, markChannelVideoAnalyzed, updateAnalysis } from "../server/db.js";
import { analyzeTranscript } from "../server/routers/analyze.js";
import * as mysql2 from "mysql2/promise";
import * as dotenv from "dotenv";
dotenv.config({ path: "/root/tradesnow/.env" });
const DB_CONFIG = { host:"127.0.0.1", user:"tradesnow", password:"TsV2026_LocalDb", database:"tradesnow", charset:"utf8mb4" as const };
async function fetchTranscript(videoId: string): Promise<string|null> {
  const apiKey = process.env.SUPADATA_API_KEY; if(!apiKey) return null;
  for (const lang of ["","&lang=iw","&lang=en"]) {
    try {
      const r=await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true${lang}`,{headers:{"x-api-key":apiKey},signal:AbortSignal.timeout(15000)});
      if(!r.ok) continue;
      const d=await r.json() as any;
      if(d?.content?.length>50) return d.content;
    } catch {}
  }
  return null;
}
async function main() {
  const conn=await (mysql2 as any).createConnection(DB_CONFIG);
  const [rows]=await conn.execute("SELECT id,videoId,mentor,title FROM channelVideos WHERE uploadDate>='2026-04-01' AND analyzedAt IS NULL ORDER BY uploadDate ASC LIMIT 3") as any[];
  console.log(`Testing ${rows.length} videos...`);
  for(const v of rows) {
    process.stdout.write(`  ${String(v.title).slice(0,45)}... `);
    const t=await fetchTranscript(v.videoId);
    if(!t){console.log("no transcript"); continue;}
    const aid=await createAnalysis({userId:1,videoUrl:`https://www.youtube.com/watch?v=${v.videoId}`,videoId:v.videoId,status:"processing"});
    await updateAnalysis(aid,{transcript:t,status:"processing"});
    const r=await analyzeTranscript(t);
    await updateAnalysis(aid,{analysisResult:JSON.stringify(r),status:"done",errorMessage:null});
    await markChannelVideoAnalyzed(v.videoId,aid);
    console.log(`✅ ${r.rows?.length??0} tickers`);
  }
  await conn.end();
}
main().catch(e=>{console.error("ERR:",e.message);process.exit(1);});

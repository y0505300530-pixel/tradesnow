# YouTube catalog batch — 2026-06-26

## Pipeline blockers (transcript path)

| Layer | Result |
|-------|--------|
| **Supadata** `/v1/youtube/transcript` | **HTTP 429** on all 16 IDs (rate limit during probe) |
| **youtube-transcript** (native captions) | **Disabled** on sampled IDs (`eTVqiCxolTY`, `BxU463WI14M`, `YoO8PLC4xTs`) |
| **Gemini 2.5 Flash** (`analyzeVideoWithGemini` via `runPipeline`) | **OK** — used for full batch |

Script: `scripts/run_user_video_batch.ts`  
Log: `docs/ziv-engine-spec/youtube-batch-run.log`  
DB: `DATABASE_URL` → `channelVideos` + `analyses` (userId=1)

## Status (16 unique IDs; `YoO8PLC4xTs` deduped)

| videoId | channelVideos | analysis | tickers | method | notes |
|---------|---------------|----------|---------|--------|-------|
| YoO8PLC4xTs | upserted + analyzed | done | 0 | gemini-direct | onboarding / no tickers |
| FwQgQvb9QlU | upserted + analyzed | done | 0 | gemini-direct | RSI education |
| eTVqiCxolTY | upserted + analyzed | done | 4 | gemini-direct | |
| 3iqhYB8VNz0 | upserted + analyzed | done | 0 | gemini-direct | Fib guide |
| BxU463WI14M | upserted + analyzed | done | 2 | gemini-direct | |
| zg-vZyQpGnM | upserted + analyzed | done | 24 | gemini-direct | |
| m8e1q4pnXVs | upserted + analyzed | done | 1 | gemini-direct | |
| G89tl2hjJQs | upserted + analyzed | done | 0 | gemini-direct | macro scan |
| ZeT5NIR8a-g | upserted + analyzed | done | 10 | gemini-direct | |
| paOvSBYcH6M | upserted + analyzed | done | 2 | gemini-direct | |
| zryV1uyM-jg | upserted + analyzed | done | 4 | gemini-direct | |
| PEe_L73vGMI | upserted + analyzed | done | 2 | gemini-direct | |
| nI37JAmj9Eg | upserted + analyzed | done | 5 | gemini-direct | |
| dxgKTSxk3rY | upserted + analyzed | done | 1 | gemini-direct | |
| lx_6phsV_qA | upserted + analyzed | done | 1 | gemini-direct | |
| F8-Hi9wYxSs | upserted + analyzed | done | 0 | gemini-direct | RSI confluence |

**Prior state:** None of these IDs were in `channelVideos` before this run (catalog-only list).

## WebFetch transcript fallback (optional follow-up)

For **0-ticker** or methodology-heavy videos, manual transcript capture from YouTube watch pages can enrich `analyses.transcript` + re-run `videoManagement.reAnalyze` (see `server/routers/videoManagement.ts`).

Catalog marks prior WebFetch availability: `eTVqiCxolTY`, `BxU463WI14M`, `dxgKTSxk3rY`, `ZeT5NIR8a-g`, `m8e1q4pnXVs` — use if Supadata quota recovers or for LLM re-parse on stored text.

## Re-run

```bash
cd /root/tradesnow && node --import tsx scripts/run_user_video_batch.ts
```

Skips videos whose latest analysis is already `done` with `analysisResult`.

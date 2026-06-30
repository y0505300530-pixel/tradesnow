/**
 * Retroactive Signal Date Correction Script
 * 
 * Updates all existing signals in masterKnowledge.activeSignals to use
 * the original video publish date instead of the analysis date.
 * 
 * Priority for each signal's source video:
 * 1. analyses.publishDate (if already populated)
 * 2. channelVideos.uploadDate (matched by videoId)
 * 3. Skip (leave signalDate as-is, log warning)
 * 
 * Run: node scripts/fix-signal-dates.mjs
 */

import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';

// Load DATABASE_URL from .env
let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  try {
    const env = readFileSync('/home/ubuntu/trading-youtube-analyzer/.env', 'utf8');
    const m = env.match(/DATABASE_URL=([^\n\r]+)/);
    if (m) dbUrl = m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
}

if (!dbUrl) {
  console.error('❌ DATABASE_URL not found. Cannot run correction script.');
  process.exit(1);
}

console.log('🔗 Connecting to database...');

const conn = await createConnection(dbUrl);

try {
  // Step 1: Get all masterKnowledge rows
  const [mkRows] = await conn.execute('SELECT id, userId, activeSignals FROM masterKnowledge');
  console.log(`📋 Found ${mkRows.length} masterKnowledge row(s) to process`);

  // Step 2: Get all analyses with their videoId and publishDate
  const [analyses] = await conn.execute(
    'SELECT id, userId, videoId, videoTitle, publishDate, createdAt FROM analyses WHERE status = "done"'
  );
  console.log(`📊 Found ${analyses.length} completed analyses`);

  // Step 3: Get all channelVideos for uploadDate lookup
  const [channelVideos] = await conn.execute(
    'SELECT videoId, uploadDate FROM channelVideos'
  );
  
  // Build lookup maps
  const channelVideoMap = new Map(); // videoId -> uploadDate
  for (const cv of channelVideos) {
    if (cv.videoId && cv.uploadDate) {
      channelVideoMap.set(cv.videoId, new Date(cv.uploadDate));
    }
  }
  console.log(`🗂️  Channel video map: ${channelVideoMap.size} entries`);

  // Build analysis map: userId -> array of { videoId, publishDate, videoTitle }
  const analysisMap = new Map(); // userId -> Map(videoTitle -> { videoId, publishDate })
  for (const a of analyses) {
    if (!analysisMap.has(a.userId)) {
      analysisMap.set(a.userId, []);
    }
    analysisMap.get(a.userId).push({
      videoId: a.videoId,
      videoTitle: a.videoTitle,
      publishDate: a.publishDate ? new Date(a.publishDate) : null,
      createdAt: new Date(a.createdAt),
    });
  }

  let totalSignals = 0;
  let fixedSignals = 0;
  let skippedSignals = 0;
  let alreadyCorrect = 0;

  // Step 4: Process each masterKnowledge row
  for (const mk of mkRows) {
    if (!mk.activeSignals) continue;
    
    let signals;
    try {
      signals = JSON.parse(mk.activeSignals);
    } catch {
      console.warn(`⚠️  Could not parse activeSignals for userId ${mk.userId}`);
      continue;
    }

    if (!Array.isArray(signals) || signals.length === 0) continue;
    
    const userAnalyses = analysisMap.get(mk.userId) || [];
    let changed = false;

    for (const signal of signals) {
      totalSignals++;
      
      // Try to find the matching analysis by source (video title)
      const matchingAnalysis = userAnalyses.find(a => 
        a.videoTitle && signal.source && 
        (a.videoTitle === signal.source || 
         a.videoTitle?.includes(signal.ticker) || 
         signal.source?.includes(a.videoTitle?.slice(0, 30)))
      );

      let correctDate = null;

      if (matchingAnalysis) {
        // Priority 1: analysis.publishDate
        if (matchingAnalysis.publishDate) {
          correctDate = matchingAnalysis.publishDate.toISOString().split('T')[0];
        }
        // Priority 2: channelVideos.uploadDate
        else if (matchingAnalysis.videoId && channelVideoMap.has(matchingAnalysis.videoId)) {
          correctDate = channelVideoMap.get(matchingAnalysis.videoId).toISOString().split('T')[0];
        }
      }

      // Also try direct channelVideo lookup if signal has a videoId hint
      if (!correctDate && signal.videoId && channelVideoMap.has(signal.videoId)) {
        correctDate = channelVideoMap.get(signal.videoId).toISOString().split('T')[0];
      }

      if (correctDate) {
        if (signal.signalDate === correctDate) {
          alreadyCorrect++;
        } else {
          const oldDate = signal.signalDate || '(none)';
          signal.signalDate = correctDate;
          changed = true;
          fixedSignals++;
          console.log(`  ✅ ${signal.ticker}: ${oldDate} → ${correctDate} (source: ${signal.source?.slice(0, 40)})`);
        }
      } else {
        skippedSignals++;
        console.log(`  ⚠️  ${signal.ticker}: No publish date found (source: ${signal.source?.slice(0, 40) || 'unknown'})`);
      }
    }

    // Step 5: Save updated signals back to DB
    if (changed) {
      await conn.execute(
        'UPDATE masterKnowledge SET activeSignals = ? WHERE id = ?',
        [JSON.stringify(signals), mk.id]
      );
      console.log(`💾 Saved updated signals for userId ${mk.userId}`);
    }
  }

  console.log('\n📈 Correction Summary:');
  console.log(`  Total signals processed: ${totalSignals}`);
  console.log(`  ✅ Fixed (date updated): ${fixedSignals}`);
  console.log(`  ✓  Already correct: ${alreadyCorrect}`);
  console.log(`  ⚠️  Skipped (no publish date found): ${skippedSignals}`);

  // Step 6: Also update analyses.publishDate from channelVideos where missing
  console.log('\n🔄 Updating analyses.publishDate from channelVideos...');
  let analysesFixed = 0;
  for (const a of analyses) {
    if (!a.publishDate && a.videoId && channelVideoMap.has(a.videoId)) {
      const uploadDate = channelVideoMap.get(a.videoId);
      await conn.execute(
        'UPDATE analyses SET publishDate = ? WHERE id = ?',
        [uploadDate, a.id]
      );
      analysesFixed++;
    }
  }
  console.log(`  ✅ Updated publishDate on ${analysesFixed} analyses records`);

} finally {
  await conn.end();
  console.log('\n✅ Script complete. Database connection closed.');
}

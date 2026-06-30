import { config } from 'dotenv';
config();

const key = process.env.SUPADATA_API_KEY;
console.log('Key present:', !!key, 'len:', key ? key.length : 0);

const videoId = 'cebH2KIvZWU';
const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true&mode=generate`;

console.log('Testing URL:', url);
const start = Date.now();

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  
  const res = await fetch(url, {
    headers: { 'x-api-key': key || '' },
    signal: controller.signal,
  });
  clearTimeout(timer);
  
  const elapsed = Date.now() - start;
  console.log('HTTP status:', res.status, '| elapsed:', elapsed, 'ms');
  const text = await res.text();
  console.log('Raw response (first 500 chars):', text.slice(0, 500));
  
  try {
    const d = JSON.parse(text);
    if (d.jobId) {
      console.log('Got async jobId:', d.jobId);
      // Poll for result
      const pollUrl = `https://api.supadata.ai/v1/transcript/${d.jobId}`;
      console.log('Polling:', pollUrl);
      
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollController = new AbortController();
        const pollTimer = setTimeout(() => pollController.abort(), 10000);
        const pollRes = await fetch(pollUrl, {
          headers: { 'x-api-key': key || '' },
          signal: pollController.signal,
        });
        clearTimeout(pollTimer);
        const pollText = await pollRes.text();
        const pollData = JSON.parse(pollText);
        console.log(`Poll ${i+1}: status=${pollData.status ?? 'unknown'} content_len=${pollData.content?.length ?? 0}`);
        if (pollData.content && pollData.content.length > 0) {
          console.log('SUCCESS! Content preview:', pollData.content.slice(0, 200));
          break;
        }
        if (pollData.error) {
          console.log('Error:', pollData.error);
          break;
        }
      }
    } else {
      console.log('content len:', d.content?.length ?? 0, '| error:', d.error ?? 'none');
      if (d.content) console.log('Content preview:', d.content.slice(0, 200));
    }
  } catch (e) {
    console.log('JSON parse error:', e.message);
  }
} catch (e) {
  const elapsed = Date.now() - start;
  console.log('FETCH ERROR:', e.name, '-', e.message, '| elapsed:', elapsed, 'ms');
}

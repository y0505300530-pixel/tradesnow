import { config } from 'dotenv';
config();

const key = process.env.SUPADATA_API_KEY;
console.log('Key present:', !!key, 'len:', key ? key.length : 0);

const videoId = 'OPLj8QBUPtU';
const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`;

const start = Date.now();
console.log('Starting fetch at', new Date().toISOString());

try {
  const res = await fetch(url, {
    headers: { 'x-api-key': key || '' },
    signal: AbortSignal.timeout(12000),
  });
  const elapsed = Date.now() - start;
  console.log('HTTP status:', res.status, '| elapsed:', elapsed, 'ms');
  const text = await res.text();
  const d = JSON.parse(text);
  console.log('content len:', d.content?.length ?? 0, '| error:', d.error ?? 'none');
} catch (e) {
  const elapsed = Date.now() - start;
  console.log('FETCH ERROR:', e.name, '-', e.message, '| elapsed:', elapsed, 'ms');
}

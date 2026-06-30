import { config } from 'dotenv';
config();

const base = process.env.BUILT_IN_FORGE_API_URL;
const key = process.env.BUILT_IN_FORGE_API_KEY;
console.log('Forge URL:', base ? base.slice(0, 50) + '...' : 'MISSING');
console.log('Forge key present:', !!key, 'len:', key?.length ?? 0);

// Test connectivity to Forge
const controller = new AbortController();
setTimeout(() => controller.abort(), 8000);
try {
  const r = await fetch(base + '/v1/models', {
    headers: { Authorization: 'Bearer ' + key },
    signal: controller.signal,
  });
  console.log('Forge /v1/models status:', r.status);
  const d = await r.json();
  const models = d.data?.map(m => m.id) ?? [];
  console.log('Available models:', models.join(', '));
} catch (e) {
  console.log('Forge connectivity error:', e.name, e.message);
}

// Test if Forge has audio transcription (Whisper)
const controller2 = new AbortController();
setTimeout(() => controller2.abort(), 8000);
try {
  const r = await fetch(base + '/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://youtu.be/cebH2KIvZWU', model: 'whisper-1' }),
    signal: controller2.signal,
  });
  console.log('Whisper endpoint status:', r.status);
  const t = await r.text();
  console.log('Whisper response:', t.slice(0, 300));
} catch (e) {
  console.log('Whisper error:', e.name, e.message);
}

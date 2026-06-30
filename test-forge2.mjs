import { config } from 'dotenv';
config();

const base = process.env.BUILT_IN_FORGE_API_URL;
const key = process.env.BUILT_IN_FORGE_API_KEY;

// Check what the Forge API supports - try the data_api endpoint for YouTube
console.log('Testing Forge data_api for YouTube transcription...');

// Try the built-in data API
const controller = new AbortController();
setTimeout(() => controller.abort(), 10000);
try {
  const r = await fetch(base + '/v1/data_api/youtube/transcript', {
    method: 'POST',
    headers: { 
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: 'https://youtu.be/cebH2KIvZWU' }),
    signal: controller.signal,
  });
  console.log('data_api/youtube/transcript status:', r.status);
  const t = await r.text();
  console.log('Response:', t.slice(0, 500));
} catch (e) {
  console.log('Error:', e.name, e.message);
}

// Try the LLM with video URL directly
console.log('\nTesting LLM with video file_url...');
const controller2 = new AbortController();
setTimeout(() => controller2.abort(), 30000);
try {
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Please transcribe the first 30 seconds of this YouTube video and extract any stock tickers mentioned.'
          },
          {
            type: 'file_url',
            file_url: {
              url: 'https://www.youtube.com/watch?v=cebH2KIvZWU',
              mime_type: 'video/mp4'
            }
          }
        ]
      }],
      max_tokens: 500
    }),
    signal: controller2.signal,
  });
  console.log('LLM video status:', r.status);
  const t = await r.text();
  console.log('Response:', t.slice(0, 500));
} catch (e) {
  console.log('Error:', e.name, e.message);
}

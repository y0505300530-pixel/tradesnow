
import * as dotenv from "dotenv";
dotenv.config({ path: "/root/tradesnow/.env" });

const API_KEY = process.env.GEMINI_API_KEY ?? "";
if (!API_KEY) { console.error("❌ GEMINI_API_KEY not set in .env"); process.exit(1); }

const videoUrl = "https://www.youtube.com/watch?v=0qmEsMuISZQ"; // SELL IN MAY — no transcript
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

const body = {
  contents: [{
    parts: [
      { video_metadata: { video_url: videoUrl } },
      { text: 'Watch this Hebrew trading video. Return JSON: {"rows":[{"ticker":"...","signal_bias":"WATCH","mentor_confidence":3}],"general_notes":"..."}. Reply ONLY JSON.' }
    ]
  }],
  generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
};

const res = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000)
});

const data = await res.json() as any;
if (!res.ok) {
  console.error("❌ Gemini error:", JSON.stringify(data).slice(0, 200));
  process.exit(1);
}
const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
console.log("✅ Gemini response:", text.slice(0, 300));

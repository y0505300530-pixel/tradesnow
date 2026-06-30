import { config } from 'dotenv';
config();

const url = process.env.BUILT_IN_FORGE_API_URL;
const key = process.env.BUILT_IN_FORGE_API_KEY;

const response = await fetch(`${url}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  },
  body: JSON.stringify({
    model: 'auto',
    messages: [
      { role: 'system', content: 'You are a trading analyst. Return ONLY valid JSON array. No markdown.' },
      { role: 'user', content: 'Generate a trade plan for IONQ. Return: [{"ticker":"IONQ","entryZone":"$10-$12","stopLoss":"$9","takeProfit":"$15","logicBadge":"AI Inference","logicDetail":"Quantum computing play","confidence":"low","dataSource":"ai_inference"}]' },
    ],
  }),
  signal: AbortSignal.timeout(30000),
});

console.log('Status:', response.status);
const text = await response.text();
console.log('First 500 chars:', text.substring(0, 500));

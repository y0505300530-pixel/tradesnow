
import { calcBearScore, calcShortSL } from './dist/server/shortEngine.js';

// Mock bars — bear breakdown scenario
const bars = Array.from({length: 200}, (_, i) => ({
  open:  100 - i * 0.3,
  high:  101 - i * 0.3,
  low:   99  - i * 0.3,
  close: 100 - i * 0.3,
  volume: i < 190 ? 1000000 : 1500000,  // last 10 bars have higher volume
  date: new Date(Date.now() - (200-i)*86400000).toISOString()
}));

const result = calcBearScore(bars);
console.log(JSON.stringify(result));

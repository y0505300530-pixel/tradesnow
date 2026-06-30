import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const IBIND_HOST = process.env.IBIND_HOST_OVERRIDE ?? "35.237.64.218";
const IBIND_PORT = parseInt(process.env.IBIND_PORT_OVERRIDE ?? "80", 10);
const bearerSecret = process.env.IBIND_API_SECRET;
const hmacSecret = process.env.IBIND_HMAC_SECRET;

function signRequest(hmacSec, bodyBuf) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const prefix = Buffer.from(`${timestamp}:${nonce}:`, "utf-8");
  const msg = Buffer.concat([prefix, bodyBuf]);
  const signature = crypto.createHmac("sha256", hmacSec).update(msg).digest("hex");
  return { timestamp, nonce, signature };
}

function ibindRequest(method, path, body) {
  const bodyBuf = body ? Buffer.from(JSON.stringify(body), "utf-8") : Buffer.alloc(0);
  const { timestamp, nonce, signature } = signRequest(hmacSecret, bodyBuf);
  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${bearerSecret}`,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": signature,
    };
    if (bodyBuf.length > 0) headers["Content-Length"] = bodyBuf.length;
    const req = http.request({ hostname: IBIND_HOST, port: IBIND_PORT, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

// Call /quotes for AVGO, DELL, GOOGL
const result = await ibindRequest('POST', '/quotes', { symbols: ['AVGO', 'DELL', 'GOOGL'], exchange_hint: 'SMART' });
const quotes = result.quotes ?? [];
for (const q of quotes) {
  console.log(`\n=== ${q.symbol ?? q.ticker} ===`);
  console.log(`  current_price: ${q.current_price}`);
  console.log(`  prior_close: ${q.prior_close}`);
  console.log(`  change: ${q.change}`);
  console.log(`  change_percent: ${q.change_percent}`);
  console.log(`  is_market_open: ${q.is_market_open}`);
  console.log(`  extended_hours_used: ${q.extended_hours_used}`);
  // Compute what the server would return
  const price = q.current_price;
  const prevClose = q.prior_close;
  const serverChange = +(price - prevClose).toFixed(4);
  const serverChangePct = +((price - prevClose) / prevClose * 100).toFixed(4);
  console.log(`  SERVER computed change: ${serverChange}`);
  console.log(`  SERVER computed changePct: ${serverChangePct}%`);
  console.log(`  RAW change from IBIND: ${q.change}`);
  console.log(`  RAW change_percent from IBIND: ${q.change_percent}`);
  console.log(`  DISCREPANCY: server_change(${serverChange}) vs raw_change(${q.change})`);
}

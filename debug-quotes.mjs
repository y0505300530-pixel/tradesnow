/**
 * Debug script: call IBIND /quotes for AVGO and DELL to see raw change/changePercent
 */
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const IBIND_HOST = process.env.IBIND_HOST_OVERRIDE ?? "35.237.64.218";
const IBIND_PORT = parseInt(process.env.IBIND_PORT_OVERRIDE ?? "80", 10);
const bearerSecret = process.env.IBIND_API_SECRET;
const hmacSecret = process.env.IBIND_HMAC_SECRET;

if (!bearerSecret || !hmacSecret) {
  console.error("Missing IBIND_API_SECRET or IBIND_HMAC_SECRET");
  process.exit(1);
}

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

    const req = http.request({
      hostname: IBIND_HOST,
      port: IBIND_PORT,
      path,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  console.log("Calling IBIND /quotes for AVGO, DELL, MU, GOOGL...");
  const result = await ibindRequest('POST', '/quotes', {
    symbols: ['AVGO', 'DELL', 'MU', 'GOOGL', 'ORCL', 'AMZN', 'NVDA'],
    exchange_hint: 'SMART'
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });

import crypto from "crypto";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const IBIND_HOST = "35.237.64.218";
const IBIND_PORT = 80;
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

function ibindReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(JSON.stringify(body), "utf-8") : Buffer.alloc(0);
    const { timestamp, nonce, signature } = signRequest(hmacSecret, bodyBuf);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${bearerSecret}`,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": signature,
    };
    if (bodyBuf.length > 0) headers["Content-Length"] = bodyBuf.length;
    const options = { hostname: IBIND_HOST, port: IBIND_PORT, path, method, headers };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log(`${method} ${path} => ${res.statusCode}: ${data.substring(0, 300)}`);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout 15s")); });
    req.on("error", reject);
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

// Test various contract search endpoints
const tests = [
  ["GET", "/iserver/secdef/search?symbol=TRX&secType=STK"],
  ["POST", "/iserver/secdef/search", { symbol: "TRX", secType: "STK" }],
  ["GET", "/contract/search?symbol=TRX"],
  ["POST", "/contract/search", { symbol: "TRX" }],
  ["GET", "/quotes?symbols=TRX"],
  ["GET", "/iserver/stocks?symbols=TRX"],
  ["GET", "/conid?symbol=TRX"],
  ["POST", "/conid", { symbol: "TRX" }],
];

for (const [method, path, body] of tests) {
  try {
    await ibindReq(method, path, body);
  } catch (e) {
    console.log(`${method} ${path} => ERROR: ${e.message}`);
  }
}

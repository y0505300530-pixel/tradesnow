import crypto from "crypto";
import http from "http";
import dotenv from "dotenv";
import { readFileSync } from "fs";

// Load env
dotenv.config();

const IBIND_HOST = "35.237.64.218";
const IBIND_PORT = 80;
const bearerSecret = process.env.IBIND_API_SECRET;
const hmacSecret = process.env.IBIND_HMAC_SECRET;

if (!bearerSecret) { console.error("Missing IBIND_API_SECRET"); process.exit(1); }
if (!hmacSecret) { console.error("Missing IBIND_HMAC_SECRET"); process.exit(1); }

function signRequest(hmacSec, bodyBuf) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const prefix = Buffer.from(`${timestamp}:${nonce}:`, "utf-8");
  const msg = Buffer.concat([prefix, bodyBuf]);
  const signature = crypto.createHmac("sha256", hmacSec).update(msg).digest("hex");
  return { timestamp, nonce, signature };
}

function ibindReq(path) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.alloc(0);
    const { timestamp, nonce, signature } = signRequest(hmacSecret, bodyBuf);
    const options = {
      hostname: IBIND_HOST,
      port: IBIND_PORT,
      path,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${bearerSecret}`,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${data.substring(0, 500)}`);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout 30s")); });
    req.on("error", reject);
    req.end();
  });
}

console.log("Testing /trsrv/stocks?symbols=TRX ...");
try {
  await ibindReq("/trsrv/stocks?symbols=TRX");
} catch (e) {
  console.error("Error:", e.message);
}

console.log("\nTesting /health ...");
try {
  await ibindReq("/health");
} catch (e) {
  console.error("Error:", e.message);
}

import * as dotenv from "dotenv";
dotenv.config();
const secret = process.env.IBIND_API_SECRET ?? "";
const hmac   = process.env.IBIND_HMAC_SECRET ?? "";
console.log("IBIND_API_SECRET len:", secret.length, "first8:", secret.slice(0,8));
console.log("IBIND_HMAC_SECRET len:", hmac.length, "first8:", hmac.slice(0,8));
// Test ibindRequest directly
const { ibindRequest } = await import("./server/routers/ibkrProxy");
try {
  const r = await ibindRequest("GET", "/session/status");
  console.log("ibindRequest result:", JSON.stringify(r.body).slice(0,200));
} catch(e) {
  console.log("ibindRequest ERROR:", String(e));
}
process.exit(0);

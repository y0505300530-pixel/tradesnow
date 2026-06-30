/** cancel-order.ts <orderId> — cancel ONE IBKR order. Run: node --env-file=.env --import tsx scripts/cancel-order.ts <id> */
import { ibindRequest } from "../server/routers/ibkrProxy";
const ACC = "U16881054";
const orderId = process.argv[2];
if (!orderId) { console.error("usage: cancel-order.ts <orderId>"); process.exit(2); }
async function main() {
  console.log(`[cancel-order] cancelling IBKR order ${orderId} on ${ACC} ...`);
  let r = await ibindRequest("DELETE", `/iserver/account/${ACC}/order/${orderId}`);
  if (!r.ok) { console.log(`  primary status=${r.status}; fallback...`); r = await ibindRequest("DELETE", `/order/${ACC}/${orderId}`); }
  console.log(`[cancel-order] ok=${r.ok} status=${r.status} body=${JSON.stringify(r.body)}`);
  process.exit(r.ok ? 0 : 1);
}
main().catch((e) => { console.error("[cancel-order] ERROR:", e?.message ?? e); process.exit(2); });

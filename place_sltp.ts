
process.env.IBIND_API_SECRET   = "aee22a0c56f42bef66ed28e4578c801b5a8b8cbd98533069bf07af1d936d4b6e";
process.env.IBIND_HMAC_SECRET  = "8151b1efb9077518be7c099c8bb10df190677700c6f714fbbe7e1a7317464e72";
process.env.IBIND_HOST_OVERRIDE = "127.0.0.1";
process.env.IBIND_PORT_OVERRIDE = "5000";

import { ibindRequest } from "./server/routers/ibkrProxy";

// Use the /order path which ibind wraps
const ORDERS = [
  { ticker: "NU",   side: "BUY", order_type: "STP", quantity: 4952, stop_price: 13.79,  label: "NU-SL"   },
  { ticker: "NU",   side: "BUY", order_type: "LMT", quantity: 4952, limit_price: 10.00, label: "NU-TP"   },
  { ticker: "SHOP", side: "BUY", order_type: "STP", quantity: 580,  stop_price: 127.51, label: "SHOP-SL" },
  { ticker: "SHOP", side: "BUY", order_type: "LMT", quantity: 580,  limit_price: 59.77, label: "SHOP-TP" },
];

for (const o of ORDERS) {
  const r = await ibindRequest("POST", "/order", {
    account_id: "U16881054",
    ticker: o.ticker,
    side: o.side,
    order_type: o.order_type,
    quantity: o.quantity,
    ...(o.stop_price  !== undefined ? { stop_price:  o.stop_price  } : {}),
    ...(o.limit_price !== undefined ? { limit_price: o.limit_price } : {}),
  });
  const orderId = (r.body as any)?.order_id ?? (r.body as any)?.orderId ?? JSON.stringify(r.body).slice(0,80);
  console.log(`${o.label} → ok=${r.ok} status=${r.status} id=${orderId}`);
  await new Promise(res => setTimeout(res, 600));
}

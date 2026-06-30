// Script to cancel all working orders one by one via the server's internal API
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcGVuSWQiOiJqYURFTVVvQ0p5eER2S3c2WHZkcnJTIiwiYXBwSWQiOiJNbVdtSmJINzdtWVlYVFphelZZcGJNIiwibmFtZSI6Ik93bmVyIiwiZXhwIjoxNzgwMzM3MjEyfQ.qazJRkd7kKYfwR6dAnuzB1a07DWB4v8BaNk8aUqc9O4";
const COOKIE = `app_session_id=${TOKEN}`;

async function callTrpc(procedure, input) {
  const url = input 
    ? `http://localhost:3000/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
    : `http://localhost:3000/api/trpc/${procedure}`;
  const res = await fetch(url, {
    method: input ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "Cookie": COOKIE },
    ...(input ? {} : { body: JSON.stringify({}) }),
  });
  return res.json();
}

// Step 1: Get working orders directly from IBKR via the paperIbindClient
// We'll use a direct node import instead
const { fetchPaperOrders, cancelSingleOrder } = await import("../server/paperIbindClient.ts");

console.log("Fetching working orders from IBKR...");
const orders = await fetchPaperOrders("working");
console.log(`Found ${orders.length} working orders`);

if (orders.length === 0) {
  console.log("No working orders to cancel!");
  process.exit(0);
}

// Step 2: Cancel each order individually
let cancelled = 0;
let failed = 0;

for (const order of orders) {
  try {
    const result = await cancelSingleOrder(order.orderId);
    if (result.success) {
      cancelled++;
    } else {
      failed++;
      console.log(`Failed to cancel ${order.orderId}: ${result.error}`);
    }
  } catch (e) {
    failed++;
    console.log(`Error cancelling ${order.orderId}: ${e.message}`);
  }
  
  // Small delay to avoid rate limiting
  if (cancelled % 50 === 0 && cancelled > 0) {
    console.log(`Progress: ${cancelled} cancelled, ${failed} failed...`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log(`\nDone! Cancelled: ${cancelled}, Failed: ${failed}`);

// Step 3: Verify
await new Promise(r => setTimeout(r, 3000));
const remaining = await fetchPaperOrders("working");
console.log(`Remaining working orders: ${remaining.length}`);

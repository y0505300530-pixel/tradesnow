/**
 * One-time script: trigger SL/TP cleanup via the running dev server's API.
 * Hits the server endpoint that runs the paper lab cycle (which includes enforceSlTpOrders).
 */

// The simplest approach: hit the server's internal endpoint
// We'll use a direct HTTP call to trigger it via the admin API
const BASE = "http://localhost:3000";

async function main() {
  console.log("[Manual Run] Calling server to trigger SL/TP enforcement...");
  
  // Use the tRPC endpoint to call paperLab.triggerSlTpEnforce if it exists,
  // otherwise we'll call the generic admin endpoint
  try {
    // Try calling the paper lab admin endpoint
    const res = await fetch(`${BASE}/api/trpc/paperLab.runSlTpEnforce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    const text = await res.text();
    console.log(`[Manual Run] Response (${res.status}):`, text.slice(0, 500));
  } catch (err) {
    console.log("[Manual Run] tRPC endpoint not available, trying direct import...");
  }
}

main();

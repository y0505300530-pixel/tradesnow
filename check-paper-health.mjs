// Check paper gateway health using fetch
const baseUrl = process.env.PAPER_API_BASE_URL || "https://paper.tradesnow.vip";
const bearer = process.env.PAPER_IBIND_API_SECRET || process.env.PAPER_API_BEARER_TOKEN;

if (!bearer) {
  console.error("No bearer token found in env");
  process.exit(1);
}

console.log(`Checking ${baseUrl}/health ...`);
console.log(`Bearer token starts with: ${bearer.substring(0, 8)}...`);

try {
  const res = await fetch(`${baseUrl}/health`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  console.log(`Status: ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
} catch (err) {
  console.error("Error:", err.message);
}

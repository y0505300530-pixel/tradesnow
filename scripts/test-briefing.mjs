/**
 * Dry-run test for Market Open Briefing → Telegram
 * Usage: node scripts/test-briefing.mjs
 */
import { execSync } from "child_process";

// Call the endpoint directly via cURL using the dev server
const result = execSync(
  `curl -s -X POST http://localhost:3000/api/scheduled/market-open-briefing \
    -H "Content-Type: application/json" \
    -b "app_session_id=$(cat /tmp/test_session_id 2>/dev/null || echo '')" \
    -d '{"session":"US"}'`,
  { encoding: "utf8" }
);

console.log("Response:", result);

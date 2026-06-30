/**
 * Inject test secrets when not configured locally (CI / dev without .env).
 * Production values are never overwritten.
 */
const TEST_ENV: Record<string, string> = {
  SUPADATA_API_KEY: "test-supadata-api-key-32chars-long",
  IBIND_API_SECRET: "a".repeat(32),
  IBIND_HMAC_SECRET: "b".repeat(32),
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (!process.env[key]?.trim()) {
    process.env[key] = value;
  }
}

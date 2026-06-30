const PLACEHOLDER_MARKERS = ["your-", "changeme", "placeholder", "example.com", "xxx"];

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some(m => lower.includes(m));
}

export const ENV = {
  get appId()               { return process.env.VITE_APP_ID ?? ""; },
  get cookieSecret()        { return process.env.JWT_SECRET ?? ""; },
  get databaseUrl()         { return process.env.DATABASE_URL ?? ""; },
  get oAuthServerUrl()      { return process.env.OAUTH_SERVER_URL ?? ""; },
  get ownerOpenId()         { return process.env.OWNER_OPEN_ID ?? ""; },
  get isProduction()        { return process.env.NODE_ENV === "production"; },
  get forgeApiUrl()         { return process.env.BUILT_IN_FORGE_API_URL ?? ""; },
  get forgeApiKey()         { return process.env.BUILT_IN_FORGE_API_KEY ?? ""; },
  get supadataApiKey()      { return process.env.SUPADATA_API_KEY ?? ""; },
  get geminiApiKey()        { return process.env.GEMINI_API_KEY ?? ""; },
  get ibindApiSecret()      { return process.env.IBIND_API_SECRET ?? ""; },
  get ibindHmacSecret()     { return process.env.IBIND_HMAC_SECRET ?? ""; },
  get ibindBaseUrl()        { return process.env.IBIND_BASE_URL ?? "http://127.0.0.1:5000"; },
  get ibkrLiveAccountId()   { return process.env.IBKR_LIVE_ACCOUNT_ID ?? ""; },
  get paperApiBaseUrl()     { return process.env.PAPER_API_BASE_URL ?? "https://tradesnow.vip/paper-api"; },
  get paperApiBearerToken() { return process.env.PAPER_API_BEARER_TOKEN ?? ""; },
  get paperIbindApiSecret() { return process.env.PAPER_IBIND_API_SECRET ?? ""; },
  get logSecret()             { return process.env.LOG_SECRET ?? ""; },
  get telegramWebhookSecret() { return process.env.TELEGRAM_WEBHOOK_SECRET ?? ""; },
};

/** Refuse boot on missing/placeholder production config. Warn on weak JWT. */
export function validateEnv(): void {
  const required: Array<{ key: string; value: string }> = [
    { key: "JWT_SECRET", value: ENV.cookieSecret },
    { key: "DATABASE_URL", value: ENV.databaseUrl },
    { key: "IBIND_API_SECRET", value: ENV.ibindApiSecret },
    { key: "IBIND_HMAC_SECRET", value: ENV.ibindHmacSecret },
  ];

  const missing = required.filter(r => !r.value.trim()).map(r => r.key);
  if (missing.length > 0) {
    throw new Error(`[ENV] Missing required environment variables: ${missing.join(", ")}`);
  }

  const placeholders = required.filter(r => isPlaceholder(r.value)).map(r => r.key);
  if (placeholders.length > 0) {
    throw new Error(`[ENV] Placeholder values detected for: ${placeholders.join(", ")}`);
  }

  if (ENV.cookieSecret.length < 32) {
    console.warn("[ENV] JWT_SECRET is shorter than 32 characters — rotate to a stronger secret.");
  }

  if (!ENV.ibkrLiveAccountId.trim()) {
    console.warn("[ENV] IBKR_LIVE_ACCOUNT_ID is not set — live order paths require this.");
  }
}

// ─── Predefined asset catalogue (60 assets) ───────────────────────────────────
// Updated v1.124: 60 top-performing tickers from the last 12 months (Mar 2025 – Mar 2026)
// Kept in a separate file so AssetPicker.tsx only exports the React component,
// which satisfies Vite Fast Refresh (no mixing of component + non-component exports).

export interface AssetDef {
  ticker: string;
  name: string;
  sector: string;
  emoji: string;
}

// Bump this version whenever the default catalogue changes significantly.
// AssetPicker will reset the DB to the new catalogue when this version changes.
export const CATALOGUE_VERSION = 2;

export const ASSET_CATALOGUE: AssetDef[] = [
  // ── Semiconductors ────────────────────────────────────────────────────────
  { ticker: "NVDA",    name: "NVIDIA Corporation",        sector: "Semiconductors", emoji: "🟢" },
  { ticker: "TSM",     name: "TSMC",                      sector: "Semiconductors", emoji: "🟢" },
  { ticker: "AVGO",    name: "Broadcom",                  sector: "Semiconductors", emoji: "🔧" },
  { ticker: "MU",      name: "Micron Technology",         sector: "Semiconductors", emoji: "💾" },
  { ticker: "ALAB",    name: "Astera Labs",               sector: "Semiconductors", emoji: "⚡" },
  { ticker: "AMD",     name: "Advanced Micro Devices",    sector: "Semiconductors", emoji: "🔴" },
  { ticker: "MRVL",    name: "Marvell Technology",        sector: "Semiconductors", emoji: "🔵" },
  { ticker: "ARM",     name: "Arm Holdings",              sector: "Semiconductors", emoji: "💪" },

  // ── Technology / Big Tech ─────────────────────────────────────────────────
  { ticker: "AAPL",    name: "Apple",                     sector: "Technology",     emoji: "🍎" },
  { ticker: "MSFT",    name: "Microsoft",                 sector: "Technology",     emoji: "🪟" },
  { ticker: "META",    name: "Meta Platforms",            sector: "Technology",     emoji: "📘" },
  { ticker: "GOOGL",   name: "Alphabet",                  sector: "Technology",     emoji: "🔍" },
  { ticker: "AMZN",    name: "Amazon",                    sector: "Technology",     emoji: "📦" },
  { ticker: "NOW",     name: "ServiceNow",                sector: "Technology",     emoji: "⚙️" },
  { ticker: "ORCL",    name: "Oracle",                    sector: "Technology",     emoji: "🏛️" },
  { ticker: "CRM",     name: "Salesforce",                sector: "Technology",     emoji: "☁️" },

  // ── AI / Data ─────────────────────────────────────────────────────────────
  { ticker: "PLTR",    name: "Palantir",                  sector: "AI / Data",      emoji: "🔮" },
  { ticker: "APP",     name: "AppLovin",                  sector: "AI / Data",      emoji: "📱" },
  { ticker: "SOUN",    name: "SoundHound AI",             sector: "AI / Data",      emoji: "🎙️" },
  { ticker: "AI",      name: "C3.ai",                     sector: "AI / Data",      emoji: "🤖" },

  // ── Crypto / Fintech ──────────────────────────────────────────────────────
  { ticker: "COIN",    name: "Coinbase",                  sector: "Crypto / Fin",   emoji: "🪙" },
  { ticker: "MSTR",    name: "MicroStrategy",             sector: "Crypto / Fin",   emoji: "₿" },
  { ticker: "MARA",    name: "Marathon Digital",          sector: "Crypto / Fin",   emoji: "⛏️" },
  { ticker: "HOOD",    name: "Robinhood Markets",         sector: "Crypto / Fin",   emoji: "🏹" },
  { ticker: "PYPL",    name: "PayPal Holdings",           sector: "Crypto / Fin",   emoji: "💰" },

  // ── Finance ───────────────────────────────────────────────────────────────
  { ticker: "JPM",     name: "JPMorgan Chase",            sector: "Finance",        emoji: "🏦" },
  { ticker: "SOFI",    name: "SoFi Technologies",         sector: "Finance",        emoji: "💵" },

  // ── Healthcare / Biotech ──────────────────────────────────────────────────
  { ticker: "LLY",     name: "Eli Lilly",                 sector: "Healthcare",     emoji: "💊" },
  { ticker: "HIMS",    name: "Hims & Hers Health",        sector: "Healthcare",     emoji: "💉" },
  { ticker: "CELH",    name: "Celsius Holdings",          sector: "Healthcare",     emoji: "🧃" },

  // ── EV / Auto ─────────────────────────────────────────────────────────────
  { ticker: "TSLA",    name: "Tesla",                     sector: "EV / Auto",      emoji: "🚗" },
  { ticker: "RIVN",    name: "Rivian Automotive",         sector: "EV / Auto",      emoji: "🔋" },

  // ── Space / Defense ───────────────────────────────────────────────────────
  { ticker: "RKLB",    name: "Rocket Lab USA",            sector: "Space",          emoji: "🚀" },
  { ticker: "LUNR",    name: "Intuitive Machines",        sector: "Space",          emoji: "🌙" },
  { ticker: "AXON",    name: "Axon Enterprise",           sector: "Defense Tech",   emoji: "⚡" },

  // ── Quantum Computing ─────────────────────────────────────────────────────
  { ticker: "IONQ",    name: "IonQ",                      sector: "Quantum",        emoji: "⚛️" },
  { ticker: "QUBT",    name: "Quantum Computing Inc.",    sector: "Quantum",        emoji: "🔬" },
  { ticker: "RGTI",    name: "Rigetti Computing",         sector: "Quantum",        emoji: "🧮" },

  // ── Nuclear / Energy ──────────────────────────────────────────────────────
  { ticker: "CEG",     name: "Constellation Energy",      sector: "Nuclear",        emoji: "☢️" },
  { ticker: "VST",     name: "Vistra Corp",               sector: "Energy",         emoji: "⚡" },
  { ticker: "NRG",     name: "NRG Energy",                sector: "Energy",         emoji: "🔌" },

  // ── Industrials / Defense ─────────────────────────────────────────────────
  { ticker: "CAT",     name: "Caterpillar",               sector: "Industrials",    emoji: "🚜" },

  // ── Consumer / Media ──────────────────────────────────────────────────────
  { ticker: "NFLX",    name: "Netflix",                   sector: "Media",          emoji: "🎬" },
  { ticker: "SPOT",    name: "Spotify",                   sector: "Media",          emoji: "🎵" },
  { ticker: "RDDT",    name: "Reddit",                    sector: "Social Media",   emoji: "🤖" },

  // ── Cybersecurity ─────────────────────────────────────────────────────────
  { ticker: "CRWD",    name: "CrowdStrike",               sector: "Cybersecurity",  emoji: "🛡️" },
  { ticker: "PANW",    name: "Palo Alto Networks",        sector: "Cybersecurity",  emoji: "🔐" },
  { ticker: "S",       name: "SentinelOne",               sector: "Cybersecurity",  emoji: "🔒" },

  // ── SaaS / Cloud ─────────────────────────────────────────────────────────
  { ticker: "DDOG",    name: "Datadog",                   sector: "SaaS",           emoji: "🐕" },
  { ticker: "NET",     name: "Cloudflare",                sector: "SaaS",           emoji: "☁️" },
  { ticker: "SNOW",    name: "Snowflake",                 sector: "SaaS",           emoji: "❄️" },

  // ── Growth / Momentum ─────────────────────────────────────────────────────
  { ticker: "SHOP",    name: "Shopify",                   sector: "E-Commerce",     emoji: "🛒" },
  { ticker: "ZIM",     name: "ZIM Integrated Shipping",   sector: "Shipping",       emoji: "🚢" },
  { ticker: "DUOL",    name: "Duolingo",                  sector: "EdTech",         emoji: "🦉" },
  { ticker: "TTD",     name: "The Trade Desk",            sector: "Ad Tech",        emoji: "📊" },
  { ticker: "AFRM",    name: "Affirm Holdings",           sector: "Fintech",        emoji: "💳" },
];

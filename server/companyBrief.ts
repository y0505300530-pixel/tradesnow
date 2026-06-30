import { normalizeTickerSymbol } from "./marketData";

export type CompanyBrief = {
  sector: string | null;
  description: string | null;
};

export type CompanyBriefContext = {
  sector?: string | null;
  companyName?: string | null;
  /** Company name from analysis row (often more accurate than catalogue) */
  rowCompany?: string | null;
};

const _briefCache = new Map<string, { data: CompanyBrief; ts: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function toTwoSentences(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const parts = cleaned.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [cleaned];
  return parts.slice(0, 2).join(" ").trim();
}

function resolveCompanyLabel(ctx?: CompanyBriefContext): string | null {
  const candidates = [ctx?.rowCompany, ctx?.companyName];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v && v !== "—") return v;
  }
  return null;
}

function inferSectorFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/semiconductor|chip|wafer|\bfab\b|foundry/.test(t)) return "Semiconductors";
  if (/\b(ai|artificial intelligence|machine learning|data center)\b/.test(t)) return "AI / Data";
  if (/\b(software|saas|cloud|cybersecurity)\b/.test(t)) return "Technology";
  if (/\b(bank|financial|insurance|asset management)\b/.test(t)) return "Financials";
  if (/\b(pharma|biotech|healthcare|medical)\b/.test(t)) return "Healthcare";
  if (/\b(oil|gas|energy|solar|renewable)\b/.test(t)) return "Energy";
  if (/\b(retail|consumer|e-commerce)\b/.test(t)) return "Consumer";
  if (/\b(defense|aerospace|military)\b/.test(t)) return "Defense";
  if (/\b(real estate|reit|property)\b/.test(t)) return "Real Estate";
  if (/\b(telecom|wireless|5g)\b/.test(t)) return "Telecom";
  return null;
}

async function fetchChartCompanyName(ticker: string): Promise<string | null> {
  const sym = normalizeTickerSymbol(ticker.toUpperCase());
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
      { signal: AbortSignal.timeout(5_000), headers: { "User-Agent": UA } },
    );
    if (!res.ok) return null;
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { longName?: string; shortName?: string } }> } };
    const meta = data.chart?.result?.[0]?.meta;
    return meta?.longName || meta?.shortName || null;
  } catch {
    return null;
  }
}

async function fetchWikipediaDescription(companyName: string, preferHebrew = false): Promise<string | null> {
  const bases = preferHebrew
    ? ["https://he.wikipedia.org", "https://en.wikipedia.org"]
    : ["https://en.wikipedia.org", "https://he.wikipedia.org"];

  const titleCandidates = [
    companyName,
    companyName.replace(/\s+(Inc\.?|Ltd\.?|Corp\.?|Corporation|PLC|N\.V\.|SA|LLC)$/i, "").trim(),
  ].filter((v, i, a) => v.length > 1 && a.indexOf(v) === i);

  for (const base of bases) {
    for (const title of titleCandidates) {
      try {
        const slug = title.replace(/ /g, "_");
        const res = await fetch(`${base}/api/rest_v1/page/summary/${encodeURIComponent(slug)}`, {
          signal: AbortSignal.timeout(5_000),
          headers: { "User-Agent": "TradeSnow/1.0" },
        });
        if (!res.ok) continue;
        const data = await res.json() as { extract?: string };
        if (data.extract && data.extract.length > 50) {
          return toTwoSentences(data.extract);
        }
      } catch { /* try next */ }
    }

    try {
      const searchRes = await fetch(
        `${base}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(companyName)}&format=json&srlimit=1&origin=*`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json() as { query?: { search?: Array<{ title: string }> } };
      const hit = searchData.query?.search?.[0]?.title;
      if (!hit) continue;
      const res = await fetch(`${base}/api/rest_v1/page/summary/${encodeURIComponent(hit.replace(/ /g, "_"))}`, {
        signal: AbortSignal.timeout(5_000),
        headers: { "User-Agent": "TradeSnow/1.0" },
      });
      if (!res.ok) continue;
      const data = await res.json() as { extract?: string };
      if (data.extract && data.extract.length > 50) {
        return toTwoSentences(data.extract);
      }
    } catch { /* next base */ }
  }
  return null;
}

async function fetchYahooBrief(ticker: string): Promise<CompanyBrief> {
  const sym = normalizeTickerSymbol(ticker.toUpperCase());
  const cached = _briefCache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const empty: CompanyBrief = { sector: null, description: null };
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile,summaryProfile`,
      { signal: AbortSignal.timeout(6_000), headers: { "User-Agent": UA } },
    );
    if (!res.ok) return empty;
    const data = await res.json() as {
      quoteSummary?: {
        result?: Array<{
          assetProfile?: { sector?: string; industry?: string; longBusinessSummary?: string };
          summaryProfile?: { sector?: string; industry?: string; longBusinessSummary?: string };
        }>;
      };
    };
    const profile = data.quoteSummary?.result?.[0]?.assetProfile
      ?? data.quoteSummary?.result?.[0]?.summaryProfile;
    if (!profile) return empty;

    const sector = profile.sector || profile.industry || null;
    const description = profile.longBusinessSummary
      ? toTwoSentences(profile.longBusinessSummary)
      : null;

    const brief = { sector, description };
    _briefCache.set(sym, { data: brief, ts: Date.now() });
    return brief;
  } catch {
    return empty;
  }
}

/** Sector + ~2-sentence business description */
export async function getCompanyBrief(
  ticker: string,
  ctx?: CompanyBriefContext,
): Promise<CompanyBrief> {
  const sym = normalizeTickerSymbol(ticker.toUpperCase());
  const cached = _briefCache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    const c = cached.data;
    return {
      sector: c.sector ?? ctx?.sector ?? null,
      description: c.description,
    };
  }

  const yahoo = await fetchYahooBrief(ticker);
  let sector = yahoo.sector ?? ctx?.sector ?? null;
  let description = yahoo.description ?? null;

  const isTase = sym.endsWith(".TA");
  let companyLabel = resolveCompanyLabel(ctx);
  if (!companyLabel) {
    companyLabel = await fetchChartCompanyName(ticker);
  }

  if (!description && companyLabel) {
    description = await fetchWikipediaDescription(companyLabel, isTase);
  }

  if (!sector && description) {
    sector = inferSectorFromText(description);
  }
  if (!sector && companyLabel) {
    sector = inferSectorFromText(companyLabel);
  }

  const brief: CompanyBrief = { sector, description };
  if (description || sector) {
    _briefCache.set(sym, { data: brief, ts: Date.now() });
  }
  return {
    sector: sector ?? (isTase ? "TASE" : null),
    description,
  };
}

export async function getCompanyBriefBatch(
  tickers: string[],
  catalogueByTicker: Map<string, { sector?: string | null; companyName?: string | null }>,
  rowCompanyByTicker?: Map<string, string>,
): Promise<Map<string, CompanyBrief>> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()))];
  const out = new Map<string, CompanyBrief>();
  const BATCH = 3;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    await Promise.all(batch.map(async (t) => {
      const cat = catalogueByTicker.get(t);
      const rowCompany = rowCompanyByTicker?.get(t);
      const brief = await getCompanyBrief(t, {
        sector: cat?.sector,
        companyName: cat?.companyName,
        rowCompany,
      });
      out.set(t, brief);
    }));
  }
  return out;
}

/** Load sector + description for Deep Analysis (catalogue + Yahoo) */
export async function getCompanyBriefForUser(
  userId: number,
  ticker: string,
): Promise<CompanyBrief> {
  const { getUserAssets } = await import("./db");
  const assets = await getUserAssets(userId);
  const cat = assets.find((a) => a.ticker.toUpperCase() === ticker.toUpperCase());
  return getCompanyBrief(
    ticker,
    cat ? { sector: cat.sector, companyName: cat.companyName } : undefined,
  );
}

export function briefFields(
  brief: CompanyBrief,
  ticker: string,
  _companyFallback?: string | null,
): { sector: string | null; companyDescription: string | null } {
  return {
    sector: brief.sector ?? (ticker.toUpperCase().endsWith(".TA") ? "TASE" : null),
    companyDescription: brief.description ?? null,
  };
}

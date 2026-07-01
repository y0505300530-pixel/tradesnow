/**
 * conidResolver.ts — Live IBKR Conid Resolution
 *
 * Resolves ticker symbols to IBKR contract IDs (conids) using the LIVE gateway.
 * Extracted from paperOrderExecutor.ts so the live engine can keep working
 * after the Paper subsystem is deleted.
 *
 * Priority: 1) tickerAliases (hardcoded known conids)
 *           2) ibkrConidCache table — tries both "SYM" and "SYM.TA" variants
 *           3) Live IBIND /quotes API (live lookup + cache write)
 *           4) Live IBIND /trsrv/stocks fallback
 *
 * @module conidResolver
 */

import { ibindRequest } from "./routers/ibkrProxy";
import { getDb } from "./db";
import { ibkrConidCache } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { getKnownConid, resolveIbkrSymbol } from "./tickerAliases";
import { log } from "./logger";

// US equity venues we treat as a clean primary listing for US tickers.
const US_VENUES = new Set([
  "NYSE", "NASDAQ", "NASDAQ.NMS", "ISLAND", "ARCA", "AMEX", "BATS",
  "IEX", "PINK", "PHLX", "BYX", "EDGEA", "EDGEX", "DRCTEDGE", "CHX",
  "NYSENAT", "NYSEAMER", "MEMX", "PEARL", "US",
]);

/**
 * Among IBKR contract/quote candidates, pick the first that looks like a clean
 * US/USD primary listing: currency is USD (or unset) AND the exchange is a known
 * US venue. Handles both /quotes shape (exchange_raw/exchange/currency) and
 * /trsrv/stocks shape (exchange/listingExchange/currency). Returns null if none —
 * caller MUST fall back to candidates[0] (no-regress).
 */
function pickUsListing<T extends Record<string, any>>(candidates: T[]): T | null {
  for (const c of candidates) {
    const cur = (c.currency ?? "").toString().toUpperCase();
    if (cur && cur !== "USD") continue;
    const ex = (c.exchange_raw ?? c.exchange ?? c.listingExchange ?? "").toString().toUpperCase();
    if (!ex) continue; // unknown exchange isn't a *strictly-better* match — keep looking
    if (US_VENUES.has(ex)) return c;
  }
  return null;
}

/**
 * Resolve a ticker symbol to an IBKR conid.
 * Priority: 1) tickerAliases (hardcoded known conids)
 *           2) ibkrConidCache table — tries both "SYM" and "SYM.TA" variants
 *           3) Live IBIND /quotes API (live lookup + cache write)
 * Returns null if not found — caller must handle gracefully.
 */
// Process-level memo: ticker(upper) -> conid. Conids are immutable per listed symbol, so
// once resolved we skip the DB read / live /quotes lookup on the entry critical path and in
// the monitor/exit/downsize loops. Only successful (non-null) resolutions are cached; a null
// (unresolved) falls through and retries next call. TASE-exchange validation stays inside the
// uncached resolver, so a bad cached DB row is still rejected before a good conid is memoized.
const _conidMemo = new Map<string, number>();

export async function resolveConid(ticker: string): Promise<number | null> {
  const _memoKey = ticker.toUpperCase();
  const _memoHit = _conidMemo.get(_memoKey);
  if (_memoHit != null) return _memoHit;
  const _resolved = await _resolveConidUncached(ticker);
  if (_resolved != null) _conidMemo.set(_memoKey, _resolved);
  return _resolved;
}

async function _resolveConidUncached(ticker: string): Promise<number | null> {
  const original = ticker.toUpperCase();
  const stripped = original.replace(/\.TA$/, "");
  const isTase = original.endsWith(".TA");

  // 1. Check hardcoded aliases (try both variants)
  for (const sym of [original, stripped]) {
    const knownConid = getKnownConid(sym);
    if (knownConid) return knownConid;
  }

  // 2. Check DB cache — try both "SYM.TA" and "SYM" variants
  //    BUT for TASE tickers, validate the cached exchange is TASE (not AMEX/NYSE)
  const db = await getDb();
  if (!db) return null;

  const symbolsToCheck = isTase ? [original, stripped] : [original];
  for (const sym of symbolsToCheck) {
    try {
      const cached = await db
        .select({ conid: ibkrConidCache.conid, exchange: ibkrConidCache.exchange })
        .from(ibkrConidCache)
        .where(eq(ibkrConidCache.symbol, sym))
        .limit(1);
      if (cached.length > 0 && cached[0].conid) {
        // TASE ticker validation: reject cached conids from wrong exchange
        if (isTase && cached[0].exchange && !['TASE', 'IL', null].includes(cached[0].exchange)) {
          log.warn("PAPER_EXEC", `Conid cache REJECTED for ${original}: cached exchange is ${cached[0].exchange} (expected TASE) — will re-resolve`);
          // Delete the bad cache entry
          try {
            await db.delete(ibkrConidCache).where(eq(ibkrConidCache.symbol, sym));
            log.info("PAPER_EXEC", `Deleted bad conid cache entry for ${sym} (was ${cached[0].exchange})`);
          } catch { /* non-fatal */ }
          continue; // Skip this bad entry, try next variant or live lookup
        }
        log.info("PAPER_EXEC", `Conid cache hit: ${original} -> ${cached[0].conid} (via key "${sym}", exchange: ${cached[0].exchange ?? 'unknown'})`);
        return cached[0].conid;
      }
    } catch (err) {
      log.warn("PAPER_EXEC", `Conid cache lookup failed for ${sym}: ${err}`);
    }
  }

  // 3. Fallback: live lookup via IBIND POST /quotes API
  //    For TASE tickers, use the ibkrSymbol alias if available
  const ibkrSym = resolveIbkrSymbol(original) ?? resolveIbkrSymbol(stripped);
  const lookupSymbol = isTase ? (ibkrSym ?? original) : (ibkrSym ?? stripped);
  try {
    const quotesPayload: any = { symbols: [lookupSymbol] };
    if (isTase) quotesPayload.exchange_hint = "TASE"; // Help gateway resolve to correct exchange
    const res = await ibindRequest("POST", "/quotes", quotesPayload);
    if (!res.ok) {
      log.warn("PAPER_EXEC", `resolveConid: POST /quotes returned ${res.status} for ${lookupSymbol}`);
    } else {
      const data = res.body as { quotes?: any[]; unresolved?: string[] };
      const quotes = data.quotes ?? [];
      // Match by ticker — try both with and without .TA suffix
      const matchingQuotes = quotes.filter((q: any) => {
        const qt = q.ticker?.toUpperCase() ?? "";
        return qt === lookupSymbol.toUpperCase() || qt === stripped.toUpperCase();
      });

      let contract: any = null;
      if (isTase) {
        // For .TA tickers, STRICTLY prefer TASE exchange to avoid NYSE/NASDAQ mismatch
        contract = matchingQuotes.find((q: any) =>
          q.exchange_raw === "TASE" || q.exchange === "IL" || q.exchange === "TASE"
        );
        if (!contract && quotes.length > 0) {
          // Broader search: any quote with TASE exchange even if ticker doesn't match exactly
          contract = quotes.find((q: any) =>
            q.exchange_raw === "TASE" || q.exchange === "IL" || q.exchange === "TASE"
          );
        }
        if (!contract) {
          log.warn("PAPER_EXEC", `resolveConid: ${original} — no TASE exchange match found in ${quotes.length} quotes. Available: ${JSON.stringify(quotes.map((q: any) => ({ t: q.ticker, ex: q.exchange_raw })))}`);
        }
      } else {
        // Non-TASE (US) tickers: PREFER a clean US/USD primary listing to avoid
        // resolving to a wrong dual/foreign listing (which then gets cached).
        // Fall back to matchingQuotes[0] if no strictly-better US/USD match exists —
        // this fallback is INTENTIONAL (no-regress): a false reject would stop the
        // engine from trading a valid name, so we never hard-refuse.
        const usMatch = pickUsListing(matchingQuotes);
        contract = usMatch ?? matchingQuotes[0];
        if (!usMatch && matchingQuotes.length > 0) {
          log.warn("LIVE_EXEC", `resolveConid: ${original} — no clean US/USD listing among ${matchingQuotes.length} quotes; falling back to first match (exchange: ${matchingQuotes[0]?.exchange_raw ?? matchingQuotes[0]?.exchange ?? 'unknown'})`);
        }
      }

      if (contract?.conid) {
        const conid = Number(contract.conid);
        // Cache the result for future lookups (keyed by original ticker)
        try {
          await db.insert(ibkrConidCache).values({
            symbol: original, conid,
            exchange: contract.exchange_raw ?? contract.exchange ?? null,
            currency: contract.currency ?? "USD",
            assetClass: "STK",
            resolvedAt: Date.now(),
          }).onDuplicateKeyUpdate({ set: { conid, resolvedAt: Date.now() } });
        } catch { /* non-fatal cache write */ }
        log.info("PAPER_EXEC", `resolveConid: resolved ${original} -> conid ${conid} via POST /quotes (${contract.exchange_raw})`);
        return conid;
      } else {
        log.warn("PAPER_EXEC", `resolveConid: no matching quote for ${original} (lookup: ${lookupSymbol})`);
      }
    }
  } catch (err: any) {
    log.warn("PAPER_EXEC", `resolveConid: POST /quotes error for ${lookupSymbol}: ${err.message}`);
  }

  // ── Fallback: try /trsrv/stocks endpoint (works even when session is degraded)
  try {
    const stocksSymbol = ibkrSym ?? stripped;
    log.info("PAPER_EXEC", `resolveConid: trying /trsrv/stocks fallback for ${original} (lookup: ${stocksSymbol})`);
    const stocksRes = await ibindRequest("GET", `/trsrv/stocks?symbols=${encodeURIComponent(stocksSymbol)}`);
    if (stocksRes.ok) {
      const stocksData = stocksRes.body as Record<string, any[]>;
      const contracts = stocksData?.[stocksSymbol] ?? stocksData?.[stocksSymbol.toUpperCase()] ?? Object.values(stocksData ?? {})[0] ?? [];
      let match: any = null;
      if (isTase) {
        match = contracts.find((c: any) =>
          c.exchange === "TASE" || c.exchange_raw === "TASE" || c.listingExchange === "TASE"
        );
      }
      if (!match && contracts.length > 0 && !isTase) {
        // Non-TASE (US) tickers: PREFER a clean US/USD primary listing; fall back to
        // contracts[0] if none. Fallback is INTENTIONAL (no-regress) — never hard-refuse.
        const usMatch = pickUsListing(contracts);
        match = usMatch ?? contracts[0];
        if (!usMatch) {
          log.warn("LIVE_EXEC", `resolveConid: ${original} — no clean US/USD listing among ${contracts.length} /trsrv/stocks contracts; falling back to first (exchange: ${contracts[0]?.exchange ?? contracts[0]?.listingExchange ?? 'unknown'})`);
        }
      }
      if (match?.conid) {
        const conid = Number(match.conid);
        try {
          await db.insert(ibkrConidCache).values({
            symbol: original, conid,
            exchange: match.exchange ?? match.listingExchange ?? null,
            currency: match.currency ?? "USD",
            assetClass: "STK",
            resolvedAt: Date.now(),
          }).onDuplicateKeyUpdate({ set: { conid, resolvedAt: Date.now() } });
        } catch { /* non-fatal cache write */ }
        log.info("PAPER_EXEC", `resolveConid: resolved ${original} -> conid ${conid} via /trsrv/stocks (${match.exchange})`);
        return conid;
      }
    }
  } catch (err: any) {
    log.warn("PAPER_EXEC", `resolveConid: /trsrv/stocks fallback error for ${original}: ${err.message}`);
  }

  log.warn("PAPER_EXEC", `resolveConid: ${original} not found in cache, /quotes, or /trsrv/stocks`);
  return null;
}

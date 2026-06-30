/**
 * autoFillConids.ts
 *
 * Background service that automatically fills missing IBKR conids for all
 * active catalogue tickers whenever an IBKR session becomes available.
 *
 * Uses POST /quotes on the IBIND server which returns conids for each symbol.
 * IMPORTANT: .TA suffix must be stripped before sending to /quotes (IBIND doesn't recognize it).
 * For .TA tickers, we filter results to ensure exchange=TASE to avoid wrong matches.
 *
 * Called from:
 *   - ibkrSessionMonitor: when session transitions inactive → active
 *   - /api/ibind/session/start: after a successful manual connect
 *   - alertPoller: 60s after server start (auto-fill on boot)
 *   - addAsset procedure: when a new ticker is added to userAssets
 *
 * Fire-and-forget: never throws, never blocks the caller.
 */
import { getDb } from "./db";
import { ibkrConidCache, userAssets } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { ibindRequest } from "./routers/ibkrProxy";
import { log } from "./logger";
import { getKnownConid, resolveIbkrSymbol } from "./tickerAliases";

let fillInProgress = false;

/**
 * Resolve and cache conids for all catalogue tickers that are missing from
 * ibkrConidCache. Safe to call multiple times — skips already-cached tickers.
 * Runs in the background; caller does not await.
 */
export async function autoFillConids(): Promise<void> {
  if (fillInProgress) {
    log.info("IBKR", "[autoFillConids] Already running — skipping duplicate call");
    return;
  }
  fillInProgress = true;
  try {
    const db = await getDb();
    if (!db) { log.warn("IBKR", "[autoFillConids] DB unavailable"); return; }

    // 1. All distinct active catalogue tickers
    const rows = await db
      .selectDistinct({ ticker: userAssets.ticker })
      .from(userAssets)
      .where(eq(userAssets.archived, 0));
    const allTickers = rows.map(r => r.ticker.toUpperCase());

    // 2. Already cached
    const cachedRows = await db.select({ symbol: ibkrConidCache.symbol }).from(ibkrConidCache);
    const cachedSet = new Set(cachedRows.map(r => r.symbol.toUpperCase()));

    // 2b. Skip untradeable tickers (indices, delisted — NOT tradeable aliases like NIKE)
    const UNTRADEABLE = new Set(["TA-BANKS.TA", "TA-INS.TA", "ENERGEAN.TA", "TA-35.TA", "TA-125.TA", "TA-90.TA", "TRX.TA", "KSTN.TA", "ESTATE15.TA", "PHINERGY.TA"]);

    // 3. Missing (excluding untradeable)
    const missing = allTickers.filter(t => !cachedSet.has(t) && !UNTRADEABLE.has(t));
    if (missing.length === 0) {
      log.info("IBKR", `[autoFillConids] All ${allTickers.length} tickers already cached — nothing to do`);
      return;
    }
    log.info("IBKR", `[autoFillConids] Resolving ${missing.length} missing conids: [${missing.join(", ")}] (${allTickers.length} total, ${cachedSet.size} cached)`);

    let resolved = 0;
    let failed = 0;
    const failedTickers: string[] = []; // Track tickers that failed /quotes for /trsrv/stocks fallback
    const BATCH = 20;
    const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);

      // ── Step 0: Check alias map for known conids (skip API call entirely) ──
      const needsApi: string[] = [];
      for (const sym of batch) {
        const knownConid = getKnownConid(sym);
        if (knownConid) {
          // Directly cache from alias map — no API call needed
          await db.insert(ibkrConidCache).values({
            symbol: sym,
            conid: knownConid,
            exchange: "ALIAS",
            currency: "USD",
            assetClass: "STK",
            resolvedAt: Date.now(),
          }).onDuplicateKeyUpdate({ set: { conid: knownConid, exchange: "ALIAS", resolvedAt: Date.now() } });
          log.info("IBKR", `[autoFillConids] ${sym} → conid ${knownConid} (alias map)`);
          resolved++;
        } else {
          needsApi.push(sym);
        }
      }

      if (needsApi.length === 0) continue;

      // ── Step 1: Resolve via IBKR symbol aliases (e.g., NIKE → NKE) ──
      const ibkrBatch = needsApi.map(s => resolveIbkrSymbol(s) ?? s.replace(/\.TA$/i, ""));
      const isTase = needsApi.map(s => s.endsWith(".TA"));

      try {
        const hasTase = isTase.some(Boolean);
        const quotesPayload: any = { symbols: ibkrBatch };
        if (hasTase) quotesPayload.exchange_hint = "TASE";
        const res = await ibindRequest("POST", "/quotes", quotesPayload);
        if (!res.ok) {
          log.warn("IBKR", `[autoFillConids] POST /quotes HTTP ${res.status} for batch starting at ${ibkrBatch[0]}`);
          failedTickers.push(...needsApi);
          failed += needsApi.length;
          continue;
        }

        const data = res.body as { quotes?: any[]; unresolved?: string[] };
        const quotes = data.quotes ?? [];
        const unresolvedSet = new Set((data.unresolved ?? []).map((s: string) => s.toUpperCase()));

        for (let j = 0; j < needsApi.length; j++) {
          const origSym = needsApi[j];
          const ibkrSym = ibkrBatch[j];
          const strippedSym = origSym.replace(/\.TA$/i, "");

          if (unresolvedSet.has(ibkrSym.toUpperCase()) || unresolvedSet.has(strippedSym.toUpperCase())) {
            log.warn("IBKR", `[autoFillConids] Unresolved via /quotes: ${origSym} (sent as ${ibkrSym}) — will try /trsrv/stocks`);
            failedTickers.push(origSym);
            failed++;
            continue;
          }

          // Find matching quote
          const matchingQuotes = quotes.filter((q: any) => {
            const qt = q.ticker?.toUpperCase() ?? "";
            return qt === origSym.toUpperCase() || qt === strippedSym.toUpperCase() || qt === ibkrSym.toUpperCase();
          });
          let contract: any = null;

          if (isTase[j]) {
            contract = matchingQuotes.find((q: any) => 
              q.exchange_raw === "TASE" || q.exchange === "IL" || q.exchange === "TASE"
            );
            if (!contract && quotes.length > 0) {
              contract = quotes.find((q: any) => 
                (q.exchange_raw === "TASE" || q.exchange === "IL") &&
                (q.ticker?.toUpperCase() === strippedSym.toUpperCase() || q.ticker?.toUpperCase() === origSym.toUpperCase())
              );
            }
            if (!contract) {
              log.warn("IBKR", `[autoFillConids] ${origSym}: No TASE exchange match — will try /trsrv/stocks`);
              failedTickers.push(origSym);
              failed++;
              continue;
            }
          } else {
            contract = matchingQuotes[0];
          }

          if (contract?.conid) {
            const conid = Number(contract.conid);
            await db.insert(ibkrConidCache).values({
              symbol: origSym,
              conid,
              exchange: contract.exchange_raw ?? contract.exchange ?? null,
              currency: contract.currency ?? "USD",
              assetClass: "STK",
              resolvedAt: Date.now(),
            }).onDuplicateKeyUpdate({ set: { conid, exchange: contract.exchange_raw ?? contract.exchange ?? null, resolvedAt: Date.now() } });
            log.info("IBKR", `[autoFillConids] ${origSym} → conid ${conid} (${contract.exchange_raw})`);
            resolved++;
          } else {
            log.warn("IBKR", `[autoFillConids] No conid via /quotes for ${origSym} — will try /trsrv/stocks`);
            failedTickers.push(origSym);
            failed++;
          }
        }
      } catch (err: any) {
        log.warn("IBKR", `[autoFillConids] Batch error`, { err: err.message });
        failedTickers.push(...needsApi);
        failed += needsApi.length;
      }
      if (i + BATCH < missing.length) await sleepMs(500);
    }

    // ── Step 2: Fallback — try /trsrv/stocks for tickers that failed /quotes ──
    if (failedTickers.length > 0) {
      log.info("IBKR", `[autoFillConids] Trying /trsrv/stocks fallback for ${failedTickers.length} tickers: [${failedTickers.join(", ")}]`);
      let fallbackResolved = 0;
      for (const origSym of failedTickers) {
        const isTase = origSym.endsWith(".TA");
        const stripped = origSym.replace(/\.TA$/i, "");
        const ibkrSym = resolveIbkrSymbol(origSym);
        const lookupSymbol = ibkrSym ?? stripped;
        try {
          const stocksRes = await ibindRequest("GET", `/trsrv/stocks?symbols=${encodeURIComponent(lookupSymbol)}`);
          if (stocksRes.ok) {
            const stocksData = stocksRes.body as Record<string, any[]>;
            const contracts = stocksData?.[lookupSymbol] ?? stocksData?.[lookupSymbol.toUpperCase()] ?? Object.values(stocksData ?? {})[0] ?? [];
            let match: any = null;
            if (isTase) {
              match = contracts.find((c: any) =>
                c.exchange === "TASE" || c.exchange_raw === "TASE" || c.listingExchange === "TASE"
              );
            }
            if (!match && !isTase && contracts.length > 0) {
              match = contracts.find((c: any) => c.assetClass === "STK") ?? contracts[0];
            }
            if (match?.conid) {
              const conid = Number(match.conid);
              await db.insert(ibkrConidCache).values({
                symbol: origSym,
                conid,
                exchange: match.exchange ?? match.listingExchange ?? null,
                currency: match.currency ?? "USD",
                assetClass: "STK",
                resolvedAt: Date.now(),
              }).onDuplicateKeyUpdate({ set: { conid, exchange: match.exchange ?? match.listingExchange ?? null, resolvedAt: Date.now() } });
              log.info("IBKR", `[autoFillConids] ${origSym} → conid ${conid} via /trsrv/stocks (${match.exchange})`);
              fallbackResolved++;
              failed--; // Undo the earlier failure count
              resolved++;
            } else {
              log.warn("IBKR", `[autoFillConids] /trsrv/stocks: no match for ${origSym} (lookup: ${lookupSymbol})`);
            }
          }
        } catch (err: any) {
          log.warn("IBKR", `[autoFillConids] /trsrv/stocks error for ${origSym}: ${err.message}`);
        }
        await sleepMs(300); // Rate limit between individual lookups
      }
      if (fallbackResolved > 0) {
        log.info("IBKR", `[autoFillConids] /trsrv/stocks fallback resolved ${fallbackResolved} additional tickers`);
      }
    }

    // ── Step 3: Live gateway fallback for TASE tickers that still failed ──
    const stillFailed = failedTickers.filter(t => t.endsWith(".TA"));
    if (stillFailed.length > 0) {
      log.info("IBKR", `[autoFillConids] Trying LIVE gateway for ${stillFailed.length} TASE tickers: [${stillFailed.join(", ")}]`);
      let liveResolved = 0;
      for (const origSym of stillFailed) {
        const stripped = origSym.replace(/\.TA$/i, "");
        try {
          // Try /trsrv/stocks on LIVE gateway (has TASE market data)
          const stocksRes = await ibindRequest("GET", `/trsrv/stocks?symbols=${encodeURIComponent(stripped)}`);
          if (stocksRes.ok) {
            const stocksData = stocksRes.body as Record<string, any[]>;
            const contracts = stocksData?.[stripped] ?? stocksData?.[stripped.toUpperCase()] ?? Object.values(stocksData ?? {})[0] ?? [];
            const match = contracts.find((c: any) =>
              c.exchange === "TASE" || c.exchange_raw === "TASE" || c.listingExchange === "TASE"
            );
            if (match?.conid) {
              const conid = Number(match.conid);
              await db.insert(ibkrConidCache).values({
                symbol: origSym,
                conid,
                exchange: "TASE",
                currency: match.currency ?? "ILS",
                assetClass: "STK",
                resolvedAt: Date.now(),
              }).onDuplicateKeyUpdate({ set: { conid, exchange: "TASE", resolvedAt: Date.now() } });
              log.info("IBKR", `[autoFillConids] ${origSym} → conid ${conid} via LIVE /trsrv/stocks (TASE)`);
              liveResolved++;
              failed--;
              resolved++;
            } else {
              log.warn("IBKR", `[autoFillConids] LIVE /trsrv/stocks: no TASE match for ${origSym} (lookup: ${stripped})`);
            }
          } else {
            log.warn("IBKR", `[autoFillConids] LIVE /trsrv/stocks HTTP ${stocksRes.status} for ${stripped}`);
          }
        } catch (err: any) {
          log.warn("IBKR", `[autoFillConids] LIVE gateway error for ${origSym}: ${err.message}`);
        }
        await sleepMs(300);
      }
      if (liveResolved > 0) {
        log.info("IBKR", `[autoFillConids] LIVE gateway resolved ${liveResolved} TASE tickers`);
      }
    }

    log.info("IBKR", `[autoFillConids] Done — resolved=${resolved}, failed=${failed}`);
  } catch (err: any) {
    log.warn("IBKR", `[autoFillConids] Unexpected error`, { err: err.message });
  } finally {
    fillInProgress = false;
  }
}

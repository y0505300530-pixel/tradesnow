# Live Browser Findings - 10:14 Israel (3:14 ET - Premarket)

## Overview Page (v14.27, IBKR Live, 10/31 quotes loaded)

| Portfolio | Value | Today% | Today$ | Total% | Total$ |
|-----------|-------|--------|--------|--------|--------|
| Holding 1 | $242,927 | +1.29% | +3,093 | +6.11% | +13,996 |
| H2 TASE | $143,989 | -26.88% | -52,937 | +3.07% | +4,289 |
| H2 USA | $33,585 | +1.00% | +333 | +13.20% | +3,917 |
| H2 Crypto | $5,268 | -2.80% | -152 | +0.00% | +0 |
| Cash | -$106,813 | +0.00% | +0 | +0.00% | +0 |
| All Accounts | $318,956 | -13.47% | -49,662 | +7.48% | +22,202 |

## CRITICAL BUGS VISIBLE:

1. **H2 TASE: $143,989 instead of ~$205,000** — Value is WRONG (should be ~$205K)
   - Today: -26.88% (-$52,937) — IMPOSSIBLE for TASE that just opened
   - This confirms the TASE divisor bug: IBKR quotes override DB with wrong unit prices
   - $205K * (ilsRate/100*ilsRate) factor = values are divided by ~100 too much

2. **H2 USA: $33,585 instead of ~$42,171** — Also wrong!
   - Was $42,171 in the earlier screenshot
   - Today +1.00% (+$333) — seems reasonable for premarket
   - But the VALUE is wrong — $33,585 vs $42,171 = ~80% of correct value

3. **All Accounts: -13.47% (-$49,662)** — Massively wrong due to H2 TASE corruption

4. **ILS box: ₪904,050 with שינוי מאתמול -₪140,762** — Wrong due to corrupted values

5. **H2 Crypto: $5,268 with +0.00% Total** — Total should not be 0% if cost = $5,268 and value = $5,268... actually that's correct (no gain)

## Root Cause Analysis:

The IBKR quotes (via getIbkrQuotes → useIbkrMarketData → h2LivePriceMap) are returning 
TASE prices in wrong units. The divisor in ibkr.ts is `ilsRate` but should be `100 * ilsRate`.

For H2 USA the issue is different — $42K → $33K. This could be because IBKR quotes 
for US stocks during premarket return a LOWER price than the DB currentPrice 
(which was last updated at market close). Actually $33,585 might be correct if 
some stocks dropped in premarket. Need to check individual tickers.

Actually wait — the IBKR progress shows 10/31 (not 28/31 like before). 
Only 10 out of 31 quotes have arrived. The remaining 21 tickers might be using 
buyPrice instead of currentPrice (because isLive=true and ibkrH2QuotesArrived 
is based on h2PriceMap having ANY data, not ALL data).

Let me check: ibkrH2QuotesArrived = Object.keys(ibkrMarketData.h2PriceMap).length > 0
If even 1 H2 quote arrived, ibkrH2QuotesArrived = true, and useDbPrice = true for ALL.
So all H2 tickers use DB currentPrice. That should be correct.

But wait — the h2LivePriceMap OVERRIDES with ibkrMarketData.h2PriceMap:
```
for (const [ticker, data] of Object.entries(ibkrMarketData.h2PriceMap)) {
  if (data?.price != null) merged[ticker] = { ...merged[ticker], ...data };
}
```

So for the 10 tickers that DID get IBKR quotes, their prices are overridden.
If those TASE prices are in wrong units (÷ilsRate instead of ÷100*ilsRate), 
the values would be ~100x too small for TASE.

$205K → $143K: the TASE portion dropped from ~$205K to ~$144K.
If some tickers got IBKR quotes with prices ÷100 too small, their contribution drops.
Not all 15 TASE tickers got quotes (only some of the 10/31 are TASE).

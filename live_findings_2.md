# Live Browser Findings #2 - After 28/31 quotes loaded

## Overview Page (v14.27, IBKR Live, 28/31 quotes)

| Portfolio | Value | Today% | Today$ | Total% | Total$ |
|-----------|-------|--------|--------|--------|--------|
| Holding 1 | $242,853 | +2.70% | +6,390 | +6.08% | +13,922 |
| H2 TASE | $205,524 | -0.12% | -254 | +47.12% | +65,824 |
| H2 USA | $42,171 | +0.04% | +16 | +42.14% | +12,503 |
| H2 Crypto | $5,153 | -2.80% | -152 | -2.18% | -115 |
| Cash | -$106,813 | +0.00% | +0 | +0.00% | +0 |
| All Accounts | $388,888 | +1.57% | +6,001 | +31.05% | +92,134 |

ILS box: ₪1,102,263 | שינוי מאתמול +₪17,008

## Comparison with first view (10/31 quotes):

When only 10/31 quotes loaded:
- H2 TASE: $143,989 (-26.88%) — WRONG
- H2 USA: $33,585 (+1.00%) — WRONG  
- All Accounts: $318,956 (-13.47%) — WRONG

After 28/31 quotes loaded:
- H2 TASE: $205,524 (-0.12%) — CORRECT ✓
- H2 USA: $42,171 (+0.04%) — CORRECT ✓
- All Accounts: $388,888 (+1.57%) — CORRECT ✓

## KEY INSIGHT:

The glitch happens DURING quote loading (10/31 → 28/31 transition).
When partial IBKR quotes arrive, some tickers get overridden with IBKR prices 
while others still use DB/seed values. 

The TASE divisor issue is CONFIRMED:
- With 10/31 quotes: TASE value = $143,989 (some tickers have wrong prices from IBKR)
- With 28/31 quotes: TASE value = $205,524 (correct — all tickers now have correct prices)

Wait — if the divisor was wrong, ALL tickers would be wrong even at 28/31.
The fact that it CORRECTS at 28/31 means something else is happening.

Actually looking more carefully:
- 10/31: H2 TASE = $143,989, H2 USA = $33,585
- 28/31: H2 TASE = $205,524, H2 USA = $42,171

The values CORRECT themselves once more quotes arrive. This means:
- The issue is with the PARTIAL state, not the final state
- When ibkrH2QuotesArrived = true (even 1 quote arrived), useDbPrice = true
- But the IBKR override loop: `for (const [ticker, data] of Object.entries(ibkrMarketData.h2PriceMap))`
  overrides ONLY the tickers that have IBKR data
- For tickers WITHOUT IBKR data yet, they use DB currentPrice (correct)
- For tickers WITH partial IBKR data... 

Hmm but if it corrects at 28/31, maybe the issue is:
- Some IBKR quotes arrive with price=0 or price=null initially
- The `if (data?.price != null)` check passes but price is very low
- OR: the first batch of TASE quotes comes back with agorot prices (not yet converted)

Actually the most likely explanation: The IBKR quote polling returns results incrementally.
First call returns 10 quotes (maybe only US stocks resolved first).
The TASE stocks that DO get resolved early have WRONG prices (divisor issue).
Then on the next poll cycle (28/31), the Gateway has fully resolved all conids and returns correct prices.

But wait — if divisor is wrong, it would ALWAYS be wrong. Unless the Gateway 
returns different formats at different times (first call: agorot, later: ILS).

OR: The first screenshot (10/31) was captured during a RACE CONDITION:
- ibkrMarketData.h2PriceMap had partial data
- Some entries had price from a DIFFERENT source (SSE/h2LivePriceMapRaw) that uses different units

Let me check: the h2LivePriceMapRaw comes from useLivePrices (SSE stream).
The SSE stream calls getLivePrices which uses fetchIbkrLivePricesBatch (divisor = 100*ilsRate).
But useIbkrMarketData calls getIbkrQuotes (divisor = ilsRate).

If BOTH are active and returning data for the same TASE tickers:
- h2LivePriceMapRaw (from SSE): correct USD prices (÷100*ilsRate)
- ibkrMarketData.h2PriceMap (from getIbkrQuotes): WRONG prices (÷ilsRate only = ILS not USD)

The merge order is:
1. Seed from DB (correct)
2. Override with h2LivePriceMapRaw (correct — from SSE/fetchIbkrLivePricesBatch)
3. Override with ibkrMarketData.h2PriceMap (WRONG — from getIbkrQuotes with wrong divisor)

So when ibkrMarketData arrives (step 3), it CORRUPTS the correct values from step 2!
But then why does it correct at 28/31?

Unless: when ibkrConnected=true, the SSE stream is SUPPRESSED (line 14-15 in useLivePrices.ts:
"When IBKR is connected, the SSE stream is suppressed").
So h2LivePriceMapRaw is EMPTY when IBKR is connected.

Flow:
1. Seed from DB: correct USD prices
2. h2LivePriceMapRaw: EMPTY (SSE suppressed because IBKR connected)
3. ibkrMarketData.h2PriceMap: prices with WRONG divisor for TASE

So the FINAL values should ALWAYS be wrong for TASE when IBKR is connected!
But at 28/31 they're correct ($205K). This contradicts my theory.

UNLESS: the getIbkrQuotes divisor IS correct (÷ilsRate) and the Gateway 
DOES return ILS (not agorot) for the new contract. And the issue at 10/31 
is something else entirely (maybe some quotes returned with legacy contract 
format that has agorot, and later all resolve to new contract with ILS).

I need to check the actual response from IBKR to confirm.

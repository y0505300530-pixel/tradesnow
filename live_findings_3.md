# CRITICAL FINDING - H2 TASE Detail Page

## H2 TASE Detail shows WRONG prices:

Header: H2 TASE = $2,055 (should be ~$205,000!)

Individual tickers:
| Ticker | Price shown | Value | Cost | Total% |
|--------|------------|-------|------|--------|
| MAXO.TA | $0.13 | $224 | $15,694 | -98.57% |
| MISH.TA | $1.74 | $183 | $14,926 | -98.78% |
| MTAV.TA | $0.58 | $177 | $9,652 | -98.16% |
| GAGR.TA | $0.06 | $164 | $13,390 | -98.77% |
| LBRA.TA | $0.06 | $157 | $11,179 | -98.59% |
| CMER.TA | $0.19 | $157 | $15,498 | -98.99% |

## ROOT CAUSE CONFIRMED:

The prices are ~100x too small! MAXO.TA showing $0.13 instead of ~$13.
This is the AGOROT → ILS conversion missing.

IBKR Gateway returns prices in AGOROT (1/100 of ILS).
- getIbkrQuotes (ibkr.ts line 1957): divides by `ilsRate` only → gets agorot/3.6 = wrong
- Should divide by `100 * ilsRate` → gets agorot/360 = USD (correct)

The comment says "Gateway returns ILS" but it's WRONG — Gateway returns AGOROT.
The proof: prices are exactly 100x too small.

MAXO.TA: showing $0.13, should be ~$13 → factor of 100x
MISH.TA: showing $1.74, should be ~$174 → factor of 100x

## Why Overview showed correct $205K at 28/31:

Looking again at the Overview data:
- Overview showed $205,524 for H2 TASE at 28/31 quotes
- But Detail shows $2,055

This means the Overview uses DIFFERENT price source than Detail!
- Overview: uses h2LivePriceMap which seeds from DB (correct) and only overrides with IBKR if available
- Detail: uses IBKR quotes DIRECTLY via useIbkrMarketData → h2PriceMap

Actually wait — both should use the same ibkrMarketData.h2PriceMap override.
Unless the Detail page has a DIFFERENT isLive/useDbPrice logic that forces IBKR prices.

The key difference: In PortfolioDetail, the h2LivePriceMap is built differently.
Let me check if Detail uses `ibkrMarketData.h2PriceMap` directly for price display.

## FIX NEEDED:

In `server/routers/ibkr.ts` line 1957:
```
// WRONG:
const divisor = isTase && ilsRate > 0 ? ilsRate : 1;
// CORRECT:
const divisor = isTase && ilsRate > 0 ? (100 * ilsRate) : 1;
```

This matches `server/marketData.ts` line 552 which correctly uses `100 * ilsRate`.

## CONFIRMED: Overview also shows $2,055 after navigating back from Detail!

After going to H2 TASE Detail (which shows $2,055) and coming back to Overview:
- H2 TASE: $2,055 (WRONG - was $205,524 before!)
- All Accounts: $185,534 (-37.48%)
- ILS: ₪525,878

This confirms: the IBKR quotes (getIbkrQuotes) corrupt the prices.
When you first load Overview, the DB prices are used (correct).
Once IBKR quotes arrive (via useIbkrMarketData polling), they override with wrong prices.

The first time I saw $205K at 28/31 was probably because the IBKR quotes hadn't 
fully propagated to the h2LivePriceMap merge yet, or there was a timing issue.

But now it's clear: **getIbkrQuotes returns TASE prices ÷ilsRate (wrong) instead of ÷(100*ilsRate) (correct)**.

The fix is simple and confirmed: line 1957 in ibkr.ts needs `100 * ilsRate`.

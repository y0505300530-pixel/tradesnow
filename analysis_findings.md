# Analysis Findings - Video v14.27 Issues

## Issue 1: H1 Detail - Header (+3.81%) vs Footer (+1.48%) inconsistency

**Root cause:** 
- Header uses `metrics.h1TodayPnl` = IBKR dailyPnl (from /pnl endpoint) = $8,920
- Footer uses `sum of rows todayDollar` = sum of per-ticker changePercent * value = $3,547

The per-ticker Today% comes from IBKR quotes `changePercent` field.
The header uses IBKR `/pnl` endpoint's `dailyPnl` field.

These use DIFFERENT baselines:
- IBKR /pnl `dailyPnl`: change from IBKR's "start of day" (which during premarket = yesterday's close)
- IBKR quotes `changePercent`: change from `prior_close` 

In premarket, these SHOULD be the same (both relative to yesterday's close).
But the discrepancy ($8,920 vs $3,547) suggests:
- Either some tickers in h1LivePriceMap don't have IBKR data (falling through to DB which has 0)
- Or the per-ticker calculation is wrong

Looking at the video: MU +2.08%, RKLB +0.59%, MRVL +2.52%, etc. — these are small numbers.
But IBKR dailyPnl = $8,920 on $242,853 = +3.81%.
Sum of visible tickers: if all 9 tickers average ~1.5% on $242K = ~$3,600. That matches footer!

So the issue is: IBKR dailyPnl reports $8,920 but the sum of individual IBKR changePercent * value = $3,547.
This means IBKR's /pnl and /quotes give DIFFERENT numbers.

**Why?** IBKR /pnl includes unrealized + realized for the day. /quotes changePercent is just price change.
During premarket, if there were any trades or the baseline differs, they diverge.

Actually the most likely cause: IBKR /pnl includes ALL positions in the account (including ones not in our H1 list),
or it uses a different baseline (mark-to-market from prior session end vs prior close).

**Fix:** The comment in the code says "Always use sum of rows for Today P&L" for the footer.
The header uses IBKR dailyPnl. This is BY DESIGN — the header shows the "IBKR official" P&L,
the footer shows the "sum of individual positions" P&L. They can legitimately differ.

But this is CONFUSING to the user. The fix should be: make header and footer consistent.
Option A: Header also uses sum-of-rows (loses IBKR accuracy)
Option B: Footer also uses IBKR dailyPnl (can't show per-ticker breakdown)
Option C: Don't show footer Today% at all (just show header)

## Issue 2: H2 TASE - Many tickers showing +0.00%

TASE market hours: Sun-Thu 09:45-17:30 Israel time.
Video timestamp: 9:24 Israel = TASE not yet open (opens at 9:45).
So +0.00% is CORRECT for most TASE tickers before market open.

But some show movement (LBRA.TA -0.22%, AVGD.TA -1.15%) — these might have pre-open auction data
or their prevClose in DB is slightly off.

Actually wait — the IBKR quotes for TASE would return `isClosingPrice: true` before market open.
So the changePercent would be 0 (price = prevClose = yesterday's close).
But LBRA.TA and AVGD.TA showing non-zero means their DB prevClose differs from IBKR prevClose.

This is NOT a bug — it's expected behavior before TASE opens.

## Issue 3: Overview Glitch - H2 TASE $205K → $2K

This is the critical bug. When navigating back to Overview:
- H2 TASE drops from $205,191 to $2,052
- Total% goes from +46.88% to -98.53%

This looks like a TASE price conversion issue:
- $205,191 → $2,052 = factor of ~100x reduction
- This matches the agorot→ILS conversion (÷100)

**Hypothesis:** When IBKR quotes arrive for TASE tickers, they might be double-converting.
- DB stores prices in USD (already converted from agorot→ILS→USD)
- IBKR getIbkrQuotes divides by ilsRate (not by 100*ilsRate like fetchIbkrLivePricesBatch)
- So frontend IBKR quotes for TASE return ILS prices (divided by ilsRate only)
- But the h2LivePriceMap expects USD prices

**CRITICAL FINDING:**
- `server/routers/ibkr.ts` line 1957: `const divisor = isTase && ilsRate > 0 ? ilsRate : 1;`
  → Divides by ilsRate only → returns ILS price
- `server/marketData.ts` line 552: `const divisor = isTase && ilsRate > 0 ? (100 * ilsRate) : 1;`
  → Divides by 100*ilsRate → returns USD price

The frontend getIbkrQuotes route (used by useIbkrMarketData) returns TASE prices in ILS!
But the DB stores them in USD. So when IBKR quotes override DB values in h2LivePriceMap,
the TASE values drop by ~100x (ILS vs USD, and missing the agorot÷100 step).

Wait no — ILS/USD rate is ~3.6, not 100. $205K / 100 = $2K. That's the agorot factor!

Actually: getIbkrQuotes divides by ilsRate (~3.6) → gets ILS price from agorot.
But it should divide by 100*ilsRate to get USD from agorot.

So TASE prices from getIbkrQuotes are in ILS (agorot/ilsRate = ILS), not USD.
DB has USD. When IBKR overrides in h2LivePriceMap, value = ILS_price * units.
ILS price ≈ USD price * 3.6, but missing the ÷100 from agorot.

Actually let me recalculate:
- If IBKR returns agorot (e.g., 30000 agorot = 300 ILS = ~$84 USD)
- getIbkrQuotes divides by ilsRate (3.6) → 30000/3.6 = 8333 (NOT correct)
- fetchIbkrLivePricesBatch divides by 100*ilsRate (360) → 30000/360 = $83.33 (correct)

So getIbkrQuotes returns values ~100x too high for TASE!
$205K (correct USD) → when IBKR quotes override → 100x too high... no that would make it bigger.

Wait, let me re-read. The video shows it going FROM $205K TO $2K. That's 100x SMALLER.
So the IBKR quotes are returning values 100x too SMALL.

If IBKR Gateway already returns ILS (not agorot) for new contract:
- getIbkrQuotes: divisor = ilsRate → ILS/ilsRate = USD ✓
- fetchIbkrLivePricesBatch: divisor = 100*ilsRate → ILS/(100*ilsRate) = USD/100 ✗

Hmm, that would mean fetchIbkrLivePricesBatch is wrong. But the DB values are correct ($205K).
So the DB was populated by fetchIbkrLivePricesBatch and shows correct values.

Actually the IBIND Gateway contract says `current_price` — need to check if it's agorot or ILS.
The comment in ibkr.ts says "TASE (prices in agorot)" but the new Gateway might return ILS directly.

The GLITCH: It only happens when navigating BACK to Overview. This suggests:
- First load: h2LivePriceMap uses DB values (correct USD)
- After navigating to Detail and back: IBKR quotes have arrived → override DB values
- If IBKR quotes for TASE are in wrong units → values crash

The fix in getIbkrQuotes should be: `const divisor = isTase && ilsRate > 0 ? (100 * ilsRate) : 1;`
OR the Gateway already returns ILS (not agorot) and fetchIbkrLivePricesBatch's ÷100 is wrong.

Need to verify which is correct by checking actual IBKR response values.

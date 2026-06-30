# Screenshot Analysis - Column Layout

Looking at the tradesnow screenshot carefully:

## AVGO row:
- Ticker: AVGO
- Price below ticker: $387.94 (current price per share)
- Column 1 (top): $31,035 (current value = 387.94 × 80)
- Column 1 (bottom): $37,242 (cost basis = 465.53 × 80)
- Column 2 (top): -2.18% (daily change %)
- Column 2 (bottom): -2,089 (daily $ change)
- Column 3 (top): -16.67% (total P&L %)
- Column 3 (bottom): -6,207 (total P&L $)

## DELL row:
- Ticker: DELL
- Price below ticker: $388.02 (current price per share)
- Column 1 (top): $19,401 (current value = 388.02 × 50)
- Column 1 (bottom): $15,979 (cost basis = 319.57 × 50)
- Column 2 (top): -3.18% (daily change %)
- Column 2 (bottom): -1,923 (daily $ change)
- Column 3 (top): +21.42% (total P&L %)
- Column 3 (bottom): +3,422 (total P&L $)

## Verification:

### AVGO Daily $ Change:
- tradesnow shows: -$2,089
- Expected: -2.18% × $31,035 = -$676 (if applied to current value)
- OR: -2.18% × $37,242 = -$812 (if applied to cost basis)
- Neither matches -$2,089!

Wait... let me try: price at screenshot = $387.94, units = 80
If todayPnl = change × units, and change = price - prevClose:
-2,089 / 80 = -26.11 change per share
prevClose would be 387.94 + 26.11 = 414.05
changePercent would be -26.11 / 414.05 = -6.3%

But the displayed % is -2.18%... MISMATCH!

### DELL Daily $ Change:
- tradesnow shows: -$1,923
- Expected: -3.18% × $19,401 = -$617 (if applied to current value)
- -1,923 / 50 = -38.46 change per share
- prevClose would be 388.02 + 38.46 = 426.48
- changePercent would be -38.46 / 426.48 = -9.02%

But displayed % is -3.18%... MISMATCH!

## CONCLUSION:
The Daily % and Daily $ are computed from DIFFERENT sources!
- Daily % comes from one source (Yahoo/DB cache = stale)
- Daily $ (todayPnl) comes from a DIFFERENT source with a much larger change value

The todayPnl computation uses `lp?.change` from holdingLivePriceMap.
The dailyChangePercent uses `holdingLivePriceMap[ticker]?.changePercent ?? h.dailyChangePercent`.

If IBKR is connected, both should come from the same IBKR source.
But if IBKR quotes failed for some tickers, the fallback paths diverge!

KEY INSIGHT: The `change` field from IBKR might be the TOTAL unrealized P&L change
(not daily), while `changePercent` is the daily percentage.

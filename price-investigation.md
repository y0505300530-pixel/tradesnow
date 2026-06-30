# Price Investigation - MNIF.TA

## Yahoo Finance Data (MNIF.TA)
- Currency: **ILA** (Israeli Agorot)
- Price: 2,730.00 ILA = 27.30 ILS
- Previous Close: 2,785.00 ILA
- EPS (TTM): 3.02

## Key Finding
Yahoo Finance reports MNIF.TA in **ILA (Israeli Agorot)**, NOT in ILS (Shekels) or USD.
- 2,730 ILA = 27.30 ILS ≈ $7.50 USD (at ~3.65 exchange rate)

## The Bug
Our system gets price from somewhere and stores it as $9.26.
- If Yahoo returns 2730 (agorot) → divide by 100 → 27.30 ILS → divide by ~3.65 → $7.48 USD
- But we have $9.26... doesn't match exactly

## IBKR API Behavior
- IBKR /quotes returns prices in the **trading currency** of the instrument
- For TASE stocks, trading currency is ILA (agorot)
- So when IBKR returns 2730 for MNIF, it means 2730 agorot = 27.30 ILS
- When we send BUY @ 9.50 to IBKR, it interprets as 9.50 in the trading currency
- For TASE: 9.50 means 9.50 AGOROT (not shekels!) = 0.095 ILS
- That's why the order never fills — we're bidding 9.50 agorot when the stock costs 2730 agorot!

## Root Cause
The entry prices in our system are in ILS (shekels) but IBKR expects AGOROT for TASE stocks.
- MNIF entry: 9.26 ILS should be sent as 926 agorot to IBKR
- Need to multiply by 100 for all .TA tickers when sending orders to IBKR

## Wait - need to verify
Actually looking at the other orders:
- NVPT: BUY @ 46.00 — if NVPT trades at ~4500 agorot (45 ILS), then 46 is wrong (should be 4600)
- SOFW: BUY @ 14.50 — if SOFW trades at ~1450 agorot (14.50 ILS), then 14.50 is wrong (should be 1450)
- AZRG: BUY @ 161.00 — if AZRG trades at ~16100 agorot (161 ILS), then 161 is wrong (should be 16100)

ALL TASE orders need to be multiplied by 100!

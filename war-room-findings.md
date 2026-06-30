# War Room Findings - May 18, 2026 12:20 UTC

## Current State from IBKR Paper (Production):
- NLV: $101.2k
- CASH: $100.0k
- Positions: 0 (IBKR shows NO open positions)
- Pending: 18
- Filled: 0
- Cancelled: 42

## Pending Orders (18 total = 6 brackets × 3 orders each):
Each bracket has: BUY Limit (entry) + SELL Stop (SL) + SELL Limit (TP)

| Ticker | BUY Entry | SELL Stop (SL) | SELL Limit (TP) | Qty |
|--------|-----------|----------------|-----------------|-----|
| TRX    | $2.55     | $2.35          | $3.50           | 1962 |
| MNIF   | $9.30     | $8.30          | $13.90          | 376 |
| NVPT   | $45.10    | $41.00         | $65.50          | 77 |
| SOFW   | $14.40    | $12.60         | $23.50          | 347 |
| AZRG   | $90.50    | $80.00         | $141.00         | 38 |
| NFTA   | $9.60     | $8.90          | $13.10          | 362 |

## Key Observations:
1. POSITIONS = 0 in IBKR → The BUY entries have NOT filled yet (still pending as Limit orders)
2. All 18 orders are PENDING — none have filled
3. The BUY Limit prices are the entry prices — these are NOT aggressive LMT (old code deployed before aggressive LMT fix)
4. The SELL orders (SL/TP) are part of the bracket — they activate only AFTER the BUY fills
5. No "immediate sell" happening — the SELL orders are just the SL and TP legs of the bracket

## Conclusion:
- These brackets were placed BEFORE the aggressive LMT fix was deployed
- The BUY entries at $2.55, $9.30, etc. are below market → they won't fill
- After the new deploy with aggressive LMT (+0.5%), new brackets will use currentPrice * 1.005
- No bug with "immediate sells" — those are just the SL/TP legs of the OCA bracket

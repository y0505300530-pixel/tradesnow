# QA Findings - Paper Trading Lab - June 8, 2026

## UI State (Production v16.5.7)
- Version: v16.5.7
- Engine: ACTIVE
- IBKR: CONNECTED
- POS: 14 (header)
- Table shows: 14 rows (9 ghosts + 5 real)
- TOTAL HOLDING: $121,231 (from IBKR grossPositionValue)
- Total Value (table footer): $89.0k — DISCREPANCY with IBKR $121.2k
- CASH: -$25,970 (NEGATIVE!)
- Leverage: 1.27x
- SL: 4, TP: 4

## Critical Issues Found

### 1. Total Value Discrepancy
- Header: $121,231 (from IBKR account summary)
- Table footer: $89.0k (sum of table rows mktValue)
- Difference: ~$32k missing
- Root cause: Ghost positions show $0 mktValue in table but IBKR counts them in grossPositionValue
- IBKR still has 9 ghost positions with residual market value that the system shows as $0

### 2. Ghost Positions (9 of 14)
- RGTI, LUNR, AFRM, AUR, GOOGL, NVDA, TSLA, CRWV, CLS
- All show "ghost (0 units)" but IBKR still counts them
- IBKR grossPositionValue includes their value ($121k vs $89k table sum)
- These should have been cleaned up / closed properly

### 3. Orphan Stuck Positions (3)
- IREN, ASTS, OPEN — all marked "orphan_stuck"
- These were recovered by DB Sync but have issues with SL/TP placement
- IREN and OPEN are BLOCKED by OrderGuard (failed 3+ times)

### 4. SL/TP Enforcement Failures
- "SL/TP: 10/20 fails" shown in UI
- IREN: BLOCKED by OrderGuard
- OPEN: BLOCKED by OrderGuard
- ASTS: SL/TP 502 — "order limit reached"
- Root cause: IBKR error "minimum of X orders working on either buy or sell side"
- This means there's ALREADY an order for that contract — duplicate order attempts

### 5. IBKR "Order Limit" 502 Error
- 491 IBKR API errors today (502/timeout)
- Error: "Your account has a minimum of X orders working on either the buy or sell side for this particular contract"
- System tries to place SL/TP but IBKR already has one → 502
- System doesn't check existing orders before placing new SL/TP

### 6. Cash is NEGATIVE (-$25,970)
- This shouldn't happen in a paper account with $95k NLV
- Likely caused by virtual cash tracker being out of sync with IBKR
- DB cash shows $200,739 (from cycle logs) but IBKR shows -$25,970

### 7. Virtual Equity Divergence
- DB virtual equity: $277,261
- IBKR NLV: $95,247
- Position Sizing correctly uses IBKR NLV but the divergence shows DB is completely out of sync

### 8. MASS DISAPPEARANCE Events (13 today)
- "4/4 positions (100%) vanished from IBKR"
- Happens when IBKR API returns empty/partial response
- System correctly doesn't auto-close but this indicates session instability

### 9. Full Reset Liquidation Still Fails
- User did Full Reset multiple times
- Positions were NOT sold (13→14 positions, not 0)
- v16.5.6 fix (skipJitCheck) was deployed but liquidation still fails
- Root cause: IBKR session drops during liquidation OR order limit errors prevent sells

### 10. Equity Curve Shows -28.20% Drop
- Seed: $132,169 → Current: $94,901
- This is a $37k loss in 7 days
- Likely caused by the DB/IBKR desync issues, not actual trading losses

### 11. S Position is SHORT (↓ S) but ALLOW SHORT is OFF
- Position "S" shows as SHORT type
- But "ALLOW SHORT: OFF" is displayed
- Inconsistency — how was a short opened if shorts are blocked?

### 12. CLS Shows as "Retest" with SL/TP but is a Ghost (0 units)
- CLS has SL=$316.27, TP=$651.14, opened 08.06 19:00
- But it shows "ghost (0 units)" with $0 value
- This means it was bought and immediately sold/stopped out but ghost remains

### 13. Peak Equity Stuck at $100K
- Circuit Breaker shows Peak Equity: $100K
- But NLV was higher ($132k seed)
- Peak equity should track the actual high watermark

### 14. "max 2 trades/day" Blocking All Entries
- Every ticker rejected: "hit max 2 trades/day limit"
- This means the counter wasn't reset properly after Full Reset
- Or the daily limit is counting trades from before the reset

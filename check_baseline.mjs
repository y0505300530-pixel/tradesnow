// Compare dailyBasePrice (our baseline) vs what IBKR App uses
// From IBKR App screenshot at 12:45 Israel time (pre-market):
// IBKR CHG%: NVDA +0.27%, AAPL -0.22%, SNDK +1.41%, MU +2.14%, CRWD -0.48%, GOOG +0.38%
// Our Today%: NVDA +2.48%, AAPL -0.11%, SNDK +2.99%, MU +4.31%, CRWD +0.29%, GOOG +0.35%

// From DB query we got:
// AAPL dailyBasePrice: 301.78, currentPrice: 301.52
// CRWD dailyBasePrice: 648.25, currentPrice: 646
// GOOG dailyBasePrice: 385.00, currentPrice: 386.21
// MU dailyBasePrice: 718.08, currentPrice: 748

// From IBKR App we can reverse-engineer their prevClose:
// CHG% = (current - prevClose) / prevClose * 100
// So: prevClose = current / (1 + CHG%/100)

// IBKR App values from screenshot (Value column / units = price per share):
// NVDA: $73,472 value, 224 shares → price ≈ $327.93/share (but wait, it says $224.00 cost... that's per share cost)
// Actually from IBKR real app: NVDA price shows in CHG% column

// Let's use the IBKR real app's P&L column to reverse-engineer:
// NVDA: P&L = +173.84, CHG% = +0.27%
// If CHG% = 0.27% and P&L = $173.84, then:
// P&L = units * (current - prevClose) = units * prevClose * (CHG%/100)
// So: prevClose = P&L / (units * CHG%/100)

// From our app: NVDA $73,472 value at $224/share cost → 328 shares (73472/224 ≈ 328)
// Actually looking at IBKR screenshot more carefully:
// NVDA: UNRLZD P&L = 816.43, UNRLZD P&L% = 1.12%
// P&L (daily) = 173.84, CHG% = 0.27%

// Let me just compute what prevClose IBKR uses:
// If daily P&L = 173.84 and CHG% = 0.27%, and we have ~328 shares:
// daily P&L = shares * (price - prevClose)
// 173.84 = 328 * (price - prevClose)
// price - prevClose = 0.53
// prevClose = price - 0.53

// From our screenshot: NVDA value = $73,472
// shares = 73472 / price
// Our Today% = 2.48% → our dailyBasePrice is much lower than IBKR's prevClose

// Key calculation:
// Our dailyBasePrice for NVDA = from DB query above (truncated, but we saw MU = 718.08)
// IBKR App shows MU CHG% = +2.14%
// Our app shows MU Today% = +4.31%

// If MU current price ≈ $749 (from IBKR: $26,216 value / ~35 shares at $749)
// IBKR prevClose = 749 / (1 + 2.14/100) = 749 / 1.0214 = 733.29
// Our dailyBasePrice = 718.08
// Our Today% = (749 - 718.08) / 718.08 * 100 = 4.31% ✓ matches!

// So the issue is clear:
// IBKR prevClose for MU = 733.29 (yesterday's regular session close at 16:00 ET)
// Our dailyBasePrice for MU = 718.08 (saved at 23:30 Israel = 16:30 ET)
// Difference: 733.29 - 718.08 = 15.21 → MU moved $15 in after-hours BEFORE our snapshot!

// Wait, that's backwards. Our dailyBasePrice (718.08) is LOWER than IBKR's prevClose (733.29).
// That means at 16:30 ET (when we saved), MU was at 718.08, but IBKR's official close was 733.29?
// That doesn't make sense. The close should be the 16:00 ET price, and by 16:30 it could be different.

// Actually wait - let me re-read. dailyBaseTs = 2026-05-20 20:34:21 UTC = 23:34 Israel = 16:34 ET
// So our dailyBasePrice was captured at 16:34 ET on May 20.
// But the OFFICIAL close for MU on May 20 should be the 16:00 ET price.
// If MU closed at 733.29 at 16:00 ET, but by 16:34 ET (after-hours) it dropped to 718.08...
// That's a $15 drop in 34 minutes of after-hours. Possible but large.

// OR: our dailyBasePrice is capturing the WRONG price. Maybe it's capturing the IBKR Gateway
// price at that moment which includes some stale/delayed data.

// Let me check: what was MU's actual close on May 20, 2026?
// From IBKR app today showing CHG% = +2.14% and current price ≈ $749:
// prevClose = 749 / 1.0214 = 733.29

// Our dailyBasePrice = 718.08 → this is WAY off from the actual close.
// 718.08 vs 733.29 = difference of $15.21 = 2.07% off

// CONCLUSION: Our dailyBasePrice is NOT the correct previous day close.
// It seems to be capturing a price that's already stale/wrong at save time.

console.log('=== Analysis ===');
console.log('');
console.log('MU example:');
console.log('  IBKR App CHG%: +2.14%');
console.log('  Our Today%: +4.31%');
console.log('  Our dailyBasePrice (from DB): 718.08');
console.log('  IBKR prevClose (reverse-engineered): 749/1.0214 = 733.29');
console.log('  Gap: 733.29 - 718.08 = $15.21 (our baseline is too low!)');
console.log('');
console.log('CRWD example:');
console.log('  IBKR App CHG%: -0.48%');
console.log('  Our Today%: +0.29%');
console.log('  Our dailyBasePrice (from DB): 648.25');
const crwdIbkrPrev = 650.11 / (1 - 0.0048); // CRWD price from our app = $650.11
console.log('  IBKR prevClose (reverse-engineered):', crwdIbkrPrev.toFixed(2));
console.log('  Gap:', (crwdIbkrPrev - 648.25).toFixed(2));
console.log('');
console.log('CONCLUSION:');
console.log('  Our dailyBasePrice (saved at 23:30 Israel/16:30 ET) does NOT match');
console.log('  the official regular session close that IBKR uses as baseline.');
console.log('  The dailyBasePrice seems to be capturing after-hours prices or stale Gateway data.');
console.log('');
console.log('FIX: Use Gateway change_percent directly instead of computing from dailyBasePrice.');
console.log('  The Gateway change_percent IS correct - it matches IBKR App CHG%.');
console.log('  Our code at line 1899-1904 in ibkr.ts RECALCULATES changePercent from');
console.log('  current_price/prior_close, which introduces the same stale-baseline problem.');
console.log('  We should pass through Gateway change_percent AS-IS.');

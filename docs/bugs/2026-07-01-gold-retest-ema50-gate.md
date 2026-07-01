# CHANGE: Gold Retest — require price above EMA50

**Reported:** 2026-07-01 (RIOT / MTSI auto-entries on falling knife)  
**Severity:** High (unwanted entry geometry)

## Symptoms

- War Engine bought **RIOT**, **MTSI** as `GOLD_RETEST_WAR` while price was falling toward / through EMA50.
- User: "סכין נופלת מתחת לממוצע — למה קנית?"

## Root cause

`genesisScore` Tier-3 (Gold Retest) used:

```ts
Math.abs(price - ema50) / ema50 <= 0.03
```

That allows entries **below** EMA50 within 3% — interpreted as "retest" but behaves like catching a falling knife.

## Fix

Gold Retest now requires:

- `price > ema200`
- `price > ema50` (strictly above)
- `(price - ema50) / ema50 <= 0.03` (within 3% **above** EMA50)
- weekly EMA50 slope > 0

File: `server/engine/elzaV45Master.ts` (`genesisScore`).

## Operational mitigation (same day)

- **Snooze** MTSI + RIOT for 720h in `snoozedTickers` (DB, not code) — blocks re-entry scan.

## Verification

1. Ticker with close below EMA50 but within 3% distance → `scoreLong` null / no ENTER.
2. Ticker 1–3% above EMA50, above EMA200, WK-L → Gold Retest still eligible.

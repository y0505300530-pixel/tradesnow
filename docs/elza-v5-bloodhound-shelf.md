# Elza v5.0 Bloodhound — Shelf Record (2026-06-28)

**Status:** PROVEN SAFE — shelved until live regime flip (`SPY < EMA-50`).

## Harness

```bash
node --import tsx --env-file=.env scripts/elzaV5BloodhoundRun.ts
```

- Core config: `server/engine/elzaV5Bloodhound.ts`
- Data: Yahoo `range=5y` deep fetch (required for 2022; `fetchBarsForTicker` is 2y-only)
- Outputs: `/tmp/elza-v5-bloodhound-2022-results.md`, `/tmp/elza-v5-bloodhound-2022-tradelog.md`

## Entry (Tier-5)

- Donchian-20 breakdown (close below prior 20-bar low)
- Price below EMA-50
- Volume ≥ 1.5× 20-day average

## Exit (Golden DNA inverted — NO time-stop / NO fast-kill)

- **SL:** Wide Lung `max(entry×1.08, EMA-50×1.01)`
- **+1.5R:** stop → breakeven
- **+2.5R:** cover 40%, runner 60%
- **Runner:** +5.0R cap or 2.5×ATR Chandelier trail
- Exits only: `SL | BE | TP_MAX | TRAIL | TRAIL_OPEN | OPEN`

## 2022 Bear-Market Proof (148 VIP catalogue, survivorship caveat)

| Metric | SPY 2022 | Bloodhound 1.0× | Bloodhound 1.9× |
| --- | --- | --- | --- |
| Net Return | -19.9% | +5.3% | +9.3% |
| Alpha vs SPY | — | +25.2% | +29.3% |
| Max Drawdown | -25.4% | -7.9% | **-14.6%** |
| Trades | — | 52 | 52 |

Exit mix (final, no TIME): BE 29 | SL 23 | TP_MAX 0 | TRAIL 0

## Strategic conclusions

1. **Survivorship bias:** 2026 VIP names (META, ASML, etc.) did not collapse in 2022 — they recovered and tagged BE. +5R fat tails are structurally rare on this catalogue.
2. **Winter hedge works:** Positive leveraged return (+9.3%) with Max DD 14.6% while SPY bled -25% — wide stop + scale-out survived short-squeeze risk.
3. **Live activation gate:** Deploy Bloodhound shorts **only when** `SPY < EMA-50` (bear regime). Do not run in bull tape.

## Live integration (future)

- Wire `calcBearScore` / warEngine short path when regime flips
- Reuse portfolio sizing from warEngine (12 slots, sector cap 3)
- No code changes to entry triggers until owner revisits Bear Wall spec

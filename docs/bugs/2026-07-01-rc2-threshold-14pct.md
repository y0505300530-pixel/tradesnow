# CHANGE: RC2 structural risk cap 12% → 14%

**Date:** 2026-07-01  
**Owner request:** allow slightly wider structural stops before War Engine skips entry.

## Behavior

RC2 skips automated entry when:

`(entry − stop) / entry > MAX_STRUCTURAL_RISK_PCT`

## Change

| Constant | Before | After |
|----------|--------|-------|
| `MAX_STRUCTURAL_RISK_PCT` (`slCalculator.ts`) | `0.12` | `0.14` |
| Engine config mirrors (`elzaV45Golden`, v5*) | `12` | `14` |

## Examples (same-day cycle)

| Ticker | Risk % | 12% | 14% |
|--------|--------|-----|-----|
| ENPH | 13.5% | blocked | **pass** |
| NVMI | 12.3% | blocked | **pass** |
| IONQ | 14.3% | blocked | blocked |
| PANW | 30.4% | blocked | blocked |

## Notes

- RC2 applies to **War Engine automated entries** via `calcEntrySlTp` in `warEngine.ts`.
- Manual orders do not use RC2 unless added separately.
- Min-R floor (`minRValuePctEnabled`) unchanged and still **INERT@0**.

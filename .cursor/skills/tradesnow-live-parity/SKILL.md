---
name: tradesnow-live-parity
description: >-
  TradeSnow Live==Backtest parity governance. Use when comparing live engine to
  backtest, elzaV45 flip, sizeFraction, Tier-4 sizing, VIX threshold, scoreLong
  SSOT, or when someone proposes a "fix" that changes live behavior vs
  elzaV45GoldenDNA. Triggers on parity, Live==Backtest, SSOT, sizeFraction,
  EXEC-3, backtest vs live, אין פשרות.
---

# TradeSnow Live==Backtest Parity (Governing SSOT)

## Iron rule (owner decision — permanent)

> **Live == Backtest is the governing SSOT. Where Genesis/red-team spec conflicts
> with the validated backtest, the backtest wins. This is a decision, not a gap.**

Do **not** wire "fixes" that improve the red-team spec but break backtest parity.

## Canonical backtest

| Artifact | Path |
|----------|------|
| Golden DNA harness | `scripts/elzaV45GoldenDNA.ts` |
| Config constants | `server/engine/elzaV45Golden.ts` |
| Live SSOT brain | `server/engine/elzaV45Master.ts` |

## Resolved conflicts (do NOT re-open without owner ADR)

| Topic | Backtest / Live SSOT | NOT a bug |
|-------|----------------------|-----------|
| Tier-4 sizing | Both tiers **1% full** (`BASE_RISK_PCT=0.01`) | `sizeFraction=0.5` is metadata only — **INTENTIONALLY NOT consumed** (`warEngine.ts` CV-C, `elzaV45Master.ts`) |
| VIX block | **35** (not 36) | `vixSizeBand` at entry gate when `elzaV45LiveEnabled=1` |
| Breakout kill-switch | v4.5 path uses `scoreLong`; legacy `goldBreakoutEnabled` is **else branch only** | Parity requires breakouts ON like backtest |
| ZIV combined gates | **Not applied** when v4.5 flag=1 | `scoreLong` replaces ZIV path deliberately |

## Live wiring map (flag-gated)

| Feature | Flag | Key files |
|---------|------|-----------|
| SSOT entry | `elzaV45LiveEnabled=1` | `warEngine.ts` ~708, `elzaScoreLong` |
| VIX entry block | same | `vixSizeBand(regime.vixProxy).block` ~728 |
| 1%-risk sizing | same (CV-B, not `riskSizingEnabled`) | `vixRiskSize` + `elzaWideLungSL` ~1541 |
| Wide-lung SL + Golden ladder | same | `liveOrderExecutor.ts` |
| Never-naked flatten | same | `liveOrderExecutor.ts` ~1241 |

Default: **`elzaV45LiveEnabled=0`** → legacy ZIV path byte-identical.

## When reviewing a proposed change

1. Does it change live behavior vs `elzaV45GoldenDNA`? → **Require owner ADR + re-backtest**
2. Does it wire `sizeFraction` or Tier-4 half-slot? → **REJECT** (breaks parity)
3. Does it change VIX 35→36? → **REJECT** unless backtest re-run
4. Does it enable v4.5 without owner flip? → **REJECT** (owner-only Monday)

## Verification commands

```bash
cd /root/tradesnow
npx vitest run server/adversarialQaV45.test.ts server/slCalculator.test.ts
```

Green adversarial tests **document parity gaps with legacy** — not "all spec items pass."

## Output

When asked "is this a bug?": classify as **Parity-by-design** | **Real bug** | **Reporting-only** | **Needs ADR**.

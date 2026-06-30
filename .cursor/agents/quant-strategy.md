# Quant-Strategy — מתמטיקה ואסטרטגיה

**כינוי:** Quant-Strategy | Quant  
**סקיל:** `tradesnow-quant-strategy`  
**מודל מומלץ:** Opus thinking  
**מצב:** מחקר + הצעות — שינוי קוד רק אם Orchestrator מאשר

## אחריות

- ניקוד אלזה: `zivEngine.ts`, `shortEngine.ts`, `warEngine.ts` thresholds
- Ziv Health / shadow: `ZIV_SHADOW`, break-even, Chandelier trail
- ניהול סיכון: R-multiples, 5:1, position sizing (`recommendedPositionSize`)
- Backtest parity: `scripts/elza-backtest*.ts`, `elzaV45GoldenDNA.ts`
- תוחלת: win rate, expectancy, drawdown — לא רק win%

## קבצי מקור

| נושא | קבצים |
|------|--------|
| Ziv score | `server/zivEngine.ts` |
| Bear / short | `server/shortEngine.ts`, `shortGuard.ts` |
| SL/TP | `server/slCalculator.ts` |
| Cycle gates | `server/cyclePhaseEngine.ts` |
| War thresholds | `warEngine.ts` LONG_ENTRY_MIN_SCORE, SHORT_ENTRY_MIN_SCORE |
| Backtest | `scripts/elza-backtest.ts`, `server/engine/elzaV45*.ts` |

## פלט נדרש

```markdown
# Quant Note: [נושא]

## Hypothesis
## Formula / threshold today
## Proposed change (if any)
## Expected impact on entries/exits
## Backtest command to validate
```

## תבנית Task

```
Full Repository Path: /root/tradesnow
Agent: Quant-Strategy
Skill: tradesnow-quant-strategy
Task: [שאלת אסטרטגיה / ניקוד / sizing]
Do NOT deploy. Propose numbers with evidence.
Return: Quant Note + file:line references
```

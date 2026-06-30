# TASE Currency Conversion — Complete Reference Map

**Last updated:** 2026-05-28  
**Purpose:** Single source of truth for how Israeli stock prices flow through the system.

---

## Currency Units

| Unit | Name | Relation | Example (FIBI.TA) |
|------|------|----------|-------------------|
| **ILA** | Israeli Agorot | Base unit (1/100 of ILS) | 8,600 ILA |
| **ILS** | Israeli Shekel | ILA ÷ 100 | 86.00 ILS |
| **USD** | US Dollar | ILS ÷ ilsRate (~2.90) | ~$29.66 USD |

> **ilsRate** = USD/ILS exchange rate fetched from Yahoo Finance (`USDILS=X`). Cached for 1 hour. Fallback: 3.60 (hardcoded).

---

## Data Sources — What Each Returns

| Source | Returns | Unit | Notes |
|--------|---------|------|-------|
| **Yahoo Finance** (chart API) | Historical bars (OHLCV) | **ILA** (Agorot) | `currency: "ILA"` in metadata |
| **Yahoo Finance** (quote API) | Live price | **ILA** (Agorot) | Same as chart |
| **IBKR Paper Gateway** (`/quotes`) | Live price | **ILS** (Shekel) | IBKR normalizes to ILS |
| **IBKR Live Gateway** (`/quotes`) | Live price | **ILS** (Shekel) | Same as Paper |
| **IBKR Paper Gateway** (`/positions`) | Position avg cost + mkt value | **ILS** (Shekel) | Quantity × ILS price |

---

## Conversion Functions — The Pipeline

### 1. `fetchBarsForTicker()` — Historical Bars

```
Yahoo Finance API → ILA (Agorot)
        ↓ ÷ 100
    Returns: ILS (Shekel)
```

**File:** `server/marketData.ts` line 338  
**Output:** Bars with OHLCV in **ILS**  
**Important:** Does NOT convert to USD. Callers must do that themselves.

---

### 2. `fetchLivePrice()` — Single Live Price (Yahoo)

```
Yahoo Finance API → ILA (Agorot)
        ↓ ÷ 100
        ILS (Shekel)
        ↓ ÷ ilsRate
    Returns: USD
```

**File:** `server/marketData.ts` line 109  
**Output:** LivePrice with price in **USD**  
**Important:** Fully converted. No additional conversion needed by callers.

---

### 3. `fetchPaperIbkrLivePricesBatch()` — Paper Lab Live Prices

```
IBKR Paper Gateway /quotes → ILS (Shekel)
        ↓ ÷ ilsRate
    Returns: USD
```

**File:** `server/marketData.ts` line 726  
**Output:** Map of ticker → price in **USD**  
**Important:** Fully converted. No additional conversion needed.

---

### 4. `fetchIbkrLivePricesBatch()` — Live IBKR Prices (Holdings)

```
IBKR Live Gateway /quotes → ILS (Shekel)
        ↓ ÷ ilsRate
    Returns: USD
```

**File:** `server/marketData.ts` line 485  
**Output:** Map of ticker → LivePrice in **USD**  
**Important:** Fully converted. Used by Portfolio Overview, Holdings pages.

---

### 5. `getUsdIlsRate()` — Exchange Rate

```
Yahoo Finance USDILS=X → rate (e.g., 2.90)
Cached for 1 hour. Fallback: hardcoded value.
```

**File:** `server/marketData.ts` line 607  
**Output:** Number (e.g., 2.90)

---

## Consumers — Who Calls What and How

### Paper Lab Engine (`server/paperLabEngine.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| Entry price | `fetchPaperIbkrLivePricesBatch` | USD | None needed | USD |
| SL/TP bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| Slow-Grind bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| EMA-20 bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| Trend Filter bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| Exit bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| DB `entryPrice` | Stored at entry | USD | None | USD |
| DB `stopLoss` | Calculated at entry | USD | None | USD |
| DB `takeProfit` | Calculated at entry | USD | None | USD |

---

### Analyze Position (`server/routers/analyzePosition.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| Historical bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| Live price | `fetchLivePrice` | USD | None needed | USD |

---

### Alert Poller — Hourly Scan (`server/alertPoller.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| CMP for Ziv Score | Yahoo Finance direct | ILA | ÷ 100 ÷ ilsRate | USD |
| DB `cmp` column | Computed above | USD | None | USD |

---

### Portfolio / Holdings (`server/routers/portfolio.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| Chart bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |
| Live prices | `fetchIbkrLivePricesBatch` | USD | None needed | USD |

---

### Manual Order (`server/routers/manualOrder.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| Live price | `fetchLivePrice` | USD | None needed | USD |
| Chart bars | `fetchBarsForTicker` | ILS | ÷ ilsRate | USD |

---

### Price Alerts (`server/routers/priceAlerts.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| Alert targets | Ziv Engine output | ILA or ILS | Heuristic: >500→÷100÷ilsRate, >5→÷ilsRate | USD |

---

### Nightly Cache Refresh (`server/routers/nightlyCacheRefresh.ts`)

| Context | Source | Input Unit | Conversion | Output Unit |
|---------|--------|------------|------------|-------------|
| Price cache | `fetchBarsForTicker` | ILS | × 100 (back to ILA) | ILA |

> **Note:** The price cache stores raw Yahoo prices in ILA for consistency with the original Yahoo data format.

---

## Common Mistakes (Historical Bugs)

| Bug | What Happened | Root Cause | Fix |
|-----|---------------|------------|-----|
| Entry price 100x too low | TASE stock entered at $0.30 instead of $30 | Divisor was `100 * ilsRate` instead of just `ilsRate` (IBKR returns ILS, not ILA) | Changed divisor to `ilsRate` only |
| analyzePosition double-convert | War Room showed wrong P&L for TASE | Bars divided by `100 * ilsRate` AND livePrice divided again | Bars: ÷ilsRate only. LivePrice: no division (already USD) |
| Cascading Circuit Breaker | Peak equity inflated to $290K | Incorrect prices caused phantom profits → CB peak set too high | One-time reset + price fix |

---

## Golden Rules

1. **`fetchBarsForTicker` returns ILS** — always divide by `ilsRate` to get USD.
2. **`fetchLivePrice` returns USD** — never divide again.
3. **`fetchPaperIbkrLivePricesBatch` returns USD** — never divide again.
4. **`fetchIbkrLivePricesBatch` returns USD** — never divide again.
5. **IBKR Gateway returns ILS** — the conversion to USD happens inside the fetch functions above.
6. **Yahoo Finance returns ILA** — the conversion to ILS (÷100) happens inside `fetchBarsForTicker`.
7. **DB stores USD** — all prices in `paperPositions`, `userAssets.cmp`, etc. are in USD.
8. **Price Cache stores ILA** — raw Yahoo format for consistency.

---

## Quick Diagnostic

If a TASE price looks wrong, check:

| Symptom | Likely Cause |
|---------|-------------|
| Price is ~100x too low | Dividing by 100 when source already returns ILS (not ILA) |
| Price is ~100x too high | Not dividing by 100 when source returns ILA |
| Price is ~3x too low | Dividing by ilsRate when source already returns USD |
| Price is ~3x too high | Not dividing by ilsRate when source returns ILS |
| Price is ~300x too low | Dividing by both 100 AND ilsRate when source already returns USD |

# One-Pager Spec — Ghost Slots + Phoenix Protocol

**גרסה:** **v1.1**  
**תאריך:** 2026-06-29  
**שלב:** **LOOP Phase 2 — BUILD** (approved)  
**בעלים:** Orchestrator → Architect  
**קהל:** LiveEngine, WarEngine, Armed Watcher, IBKR sync, GoldenExit

---

## 0. Executive Summary

| מודול | בעיה | פתרון |
|--------|------|--------|
| **Ghost Slots** | 12 slots → choke; runners ב-BE תופסים slot | **+1.5R + BE מאומת** → slot− ; exit management נמשך |
| **Phoenix Protocol** | High-beta whipsaw | Re-arm 5m **מוגבל** ; sizing **1% recalc** |

**עקרון מנחה:** Ghost = **Elza slot accounting**. Phoenix = **lifecycle exception**. שניהם **לא** עוקפים IBKR gross / margin.

---

## 0.1 Architect Sign-Off (v1.1)

| Role | Status | Date |
|------|--------|------|
| CEO direction (ADRs) | ✅ Approved | 2026-06-29 |
| Architect engineering review | ✅ **SIGN-OFF — BUILD authorized** | 2026-06-29 |

**החותמת:** ההחלטות **אטומות הנדסית** בתנאi ש-Loop 2 מיישם את **Guardrails G1-A..G1-D** (להלן). **Backtest baseline (`elzaV45GoldenDNA`) לא נשבר** — Ghost/Phoenix מוגדרים כ-**LIVE_OPS_OVERLAY** (לא משנים exit ladder של Golden 2.5R / 5R).

---

## 1. State Machine (Armed Watcher × LiveEngine)

```
PENDING_ENTRY → ACTIVE (slot+) → GHOST (slot− @ 1.5R+BE) → CLOSED
                      ↓ Wide Lung stop (same day)
                 STOPPED_TODAY → PHOENIX_ARMED (5m) → ACTIVE (slot+, 1% recalc)
```

- **slot+** = `countsTowardSlot = 1`
- **slot−** = `slotGhost = 1`, `countsTowardSlot = 0`, `status` stays `open`
- **openTickerSet** = **includes** ghost tickers (ADR-G2 locked)

---

## 2. מודול 1 — Ghost Slots

### 2.1 Trigger — **ADR-G1 RESOLVED: +1.5R @ Breakeven**

**החלטה (CEO):** Ghost מופעל ב-**+1.5R** — ברגע שהסיכון הדולרי המעשי ≈ 0 (SL ב-BE **מאומת ב-IBKR**), הסלוט משתחרר. **לא** ממתינים ל-Golden Scale @ 2.5R.

**Trigger canonical (ALL required):**

```
unrealizedGain >= 1.5 × rValue          // per-share, direction-aware
AND slMovedToBreakEven = 1
AND currentSl >= entryPrice             // long (mirror for short)
AND ibkr_sl_verified = true             // resting stop confirmed at/through BE
AND ghostSlotsEnabled = 1
→ SET slotGhost=1, countsTowardSlot=0, ghostStage='FREE_ROLL_1.5R_BE'
```

**מה *לא* משנה Ghost trigger:**
- Golden `SCALE_40 @ +2.5R` — **נשאר** (exit ladder / parity)
- Open Skies 50% partial @ **+2R** (`SCALE_OUT_TP1_R`) — **נפרד** ; partial אופציונלי אחרי Ghost

#### Side effects & Guardrails (חובה ב-BUILD)

| ID | סיכון | Mitigation |
|----|--------|------------|
| **G1-A** | Ghost לפני BE אמיתי ב-IBKR → slot free אבל עדיין risk | Ghost **רק** אחרי `ibkr_sl_verified` (אותו poller שמאשר `replaceStopToBreakeven`) |
| **G1-B** | Full-size ghost (לא partial) — notional גבוה ב-IBKR | **מכוון** — slot≠margin; UI: "Slot פנוי, exposure נשאר" |
| **G1-C** | `zivOpenHeatUsd` לא מתאפס | Recalc heat: ghost rows contribute **0** planned risk |
| **G1-D** | פיצול 1.5R (warEngine BE) vs 2R (partial) vs 2.5R (Golden) | **Single hook:** `onBreakevenConfirmed(pos)` → ghost ; לא לשלב בתוך `goldenExitDecision` |

**Parity statement:** Backtest exit math **unchanged**. Ghost = live slot cap only. Document in `tradesnow-live-parity` as `LIVE_OPS_OVERLAY`.

### 2.2 מה משתנה / מה לא

| שכבה | Ghost = false | Ghost = true |
|------|---------------|--------------|
| **Slot count** (ELZA 12 / `dynamicMaxPos`) | +1 | **0** |
| **IBKR gross / leverage** | נספר | **נספר** |
| **openTickerSet** | blocked | **still blocked** (ADR-G2) |
| **Portfolio heat** | full SL risk | **≈ 0** (BE verified) |
| **GoldenExit / Open Skies / trail** | רץ | **רץ** (incl. 2.5R scale if not yet fired) |
| **IronRule1 deployedUsd** | IBKR gross | **IBKR gross** (unchanged) |

### 2.3 DB fields

```typescript
slotGhost:        tinyint default 0
ghostAt:          timestamp null
ghostStage:       'FREE_ROLL_1.5R_BE' | 'GOLDEN_SCALE_2.5R'  // latter legacy-only
countsTowardSlot: tinyint default 1   // 0 when ghost
```

`status` remains `open` (no new enum v1).

### 2.4 Transitions

```
ON onBreakevenConfirmed (+1.5R, IBKR SL verified):
  SET slotGhost=1, countsTowardSlot=0
  LOG [GhostSlot] slot freed; IBKR qty unchanged

ON close (any exit):
  CLEAR ghost flags

ON manual_close(ghost):
  standard close + clear flags
```

### 2.5 Gross Exposure guardrails (unchanged — CEO approved)

1. Slot freed ≠ margin freed  
2. IronRule1 reads IBKR gross  
3. Deleverage EOD includes ghost positions  
4. Circuit breaker / HALT applies to ghosts  

---

## 3. מודול 2 — Phoenix Protocol

### 3.1 Story

Breakout → Wide Lung stop → same-day 5m reclaim above `breakoutLine` → **one** re-entry.

### 3.2 Preconditions (ALL)

| # | Gate |
|---|------|
| P1 | Entry origin: **GOLD_BREAKOUT_WAR** or Armed **FULL BREAK** only (ADR-P3) |
| P2 | Closed **today** ; `exitReason` ∈ `{STOP, …}` ; not manual |
| P3 | `exitPrice ≤ initialSl × 1.002` (true Wide Lung stop) |
| P4 | **5m close** > frozen `breakoutLine` (donchian×0.995 at origin) |
| P5 | נמ"ס intraday on reclaim bar |
| P6–P9 | Anti-loop, global gates, slot+, **1% recalc** (ADR-P1) |

### 3.3 ADR-P1 RESOLVED: Recalc 1% (not original qty)

**החלטה (CEO):** Phoenix = **כניסה חדשה** → `vixRiskSize` / `computeRiskSizedQty` עם:

```
entry  = 5m reclaim close (live IBKR)
stop   = min( reclaimBarLow − buffer, wideLungSL(entry, ema50) )
nlv, vix, heat caps = same as tryLiveEntry
qty    = floor( (NLV × 1% × vixMult) / |entry − stop| )
```

**Hard cap (anti-oversize):** `qty ≤ originQty × 1.25` (config) — prevents 1% blow-up on tight reclaim stop.

**Engineering note:** Sizing is **pure math** (`sizingEngine.ts`, `elzaV45Master.vixRiskSize`). Phoenix 5m loop needs per candidate:
- 1× quote (already watched ticker)
- NLV from cached `getLiveConfig` (same as War cycle)
- **No** full 147-ticker scan

**5m bars:** **Cached** (ADR-P2) — `fetchIntradayBars(ticker, '5m')` with TTL 60s; IBKR fallback on cache miss only.

### 3.4 Anti-loop matrix (unchanged + P1 update)

| Guard | Limit |
|-------|-------|
| Per ticker / day | 1 Phoenix |
| Account / day | 3 Phoenix |
| 2nd stop same day | ticker done |
| Size | **1% recalc**, cap vs origin qty |
| Ghost open same ticker | blocked |
| Cooldown after Phoenix stop | 30 min |

### 3.5 Phoenix Watcher (isolated)

- Cron: `phoenix5mPollSec = 60`
- Input: `phoenixLedger WHERE status='eligible'`
- Output: `tryLiveEntry({ signal: 'PHOENIX_REENTRY', … })`
- **Not** invoked from War Engine 20m scan

### 3.6 DB

```typescript
phoenixLedger: { originPosId, ticker, tradeDate, breakoutLine, stopPrice,
  reclaimPrice, status, phoenixQty, plannedRiskUsd, … }

livePositions: phoenixGeneration tinyint default 0  // 0=origin, 1=phoenix
               originPosId int null
```

---

## 4. Resolved ADRs (v1.1)

| ID | Decision | Rationale |
|----|----------|-----------|
| **ADR-G1** | ✅ **Ghost @ +1.5R when BE verified on IBKR** | Slot freed at zero dollar risk; Golden 2.5R unchanged |
| **ADR-G2** | ✅ **Ghost ∈ openTickerSet** | No duplicate ticker exposure |
| **ADR-P1** | ✅ **Phoenix = 1% recalc** + origin qty cap | Structural new stop ; risk SSOT |
| **ADR-P2** | ✅ **Cached 5m bars** | Rate-limit safe |
| **ADR-P3** | ✅ **FULL break only** | No Phoenix on PRE_BREAK v1 |

---

## 5. Interaction Matrix (Ghost × Phoenix)

| Scenario | Outcome |
|----------|---------|
| Active → 1.5R BE → Ghost → 2.5R Golden scale | Allowed ; slot already free |
| Active → Wide Lung SL → 5m reclaim | Phoenix eligible → new ACTIVE |
| Ghost → BE stop hit | Close ; **no Phoenix** |
| Phoenix → 1.5R → Ghost | Same rules |
| 12 slots full + ghosts | New entries allowed (slot−) |

---

## 6. Feature flags

```typescript
ghostSlotsEnabled:      0  // BUILD S0/S1
phoenixProtocolEnabled: 0  // BUILD S2/S3
phoenixMaxPerDay:       3
phoenix5mPollSec:       60
phoenixQtyCapMult:      1.25  // vs origin qty
```

**Deploy order:** Ghost S0→S1 → Phoenix S0→S1 (Watcher isolated throughout).

---

## 7. Loop 2 — BUILD slices

| Slice | Deliverable | Flag |
|-------|-------------|------|
| **G-S0** | Migration: `slotGhost`, `countsTowardSlot`, `ghostAt`, `ghostStage` | OFF |
| **G-S1** | `onBreakevenConfirmed` hook ; warEngine slot counter ; heat=0 ; logs | ON test |
| **G-S2** | War Room GHOST badge ; slots `active/ghost/free` | — |
| **P-S0** | `phoenixLedger` ; eligibility on Wide Lung close | OFF |
| **P-S1** | Phoenix 5m watcher ; `PHOENIX_REENTRY` + `vixRiskSize` | ON test |
| **P-S2** | Replay harness: ALAB-like whipsaw day | — |

**Tests required before prod flag:**
- Unit: slot counter with 3 active + 2 ghost = 3 counted  
- Unit: Phoenix sizing with tight reclaim stop  
- Integration: ghost only after IBKR SL mock confirmed  

---

## 8. Acceptance criteria — v1.1

- [x] State diagram approved (CEO)
- [x] ADR-G1 resolved → **1.5R + BE verified**
- [x] ADR-G2 → ghost in openTickerSet
- [x] ADR-P1 → 1% recalc
- [x] ADR-P2/P3 → cached 5m / FULL break only
- [x] IBKR gross vs slot messaging approved
- [x] Architect sign-off → **BUILD**
- [ ] G-S1 + P-S1 tests green (Loop 2 exit gate)

---

## 9. Out of scope (unchanged)

- Armed Watcher PRE_BREAK body  
- Changing ELZA_MAX_LONG from 12  
- IBKR gross bypass  
- Phoenix on daily bar only  

---

*End of One-Pager — Ghost Slots + Phoenix Protocol **v1.1***  
*Previous: v0.1 (2026-06-29 Loop 1 SPEC)*

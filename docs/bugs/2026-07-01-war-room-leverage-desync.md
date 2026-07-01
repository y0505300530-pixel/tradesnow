# BUG: War Room leverage controls out of sync

**Reported:** 2026-07-01  
**Severity:** High (safety-critical misread of live leverage)

## Symptoms

- **Leverage Cockpit** (INTRADAY POWER / OVERNIGHT sliders) shows e.g. **3.5×** intraday, **1.8×** overnight.
- **Bottom control panel** (מינוף — שעות מסחר / לילה) shows **1.9×** / **1.8×** for the same session.
- User expects both controls to reflect the same `liveEngineConfig` values.

## Root cause

1. **Duplicate UI, separate local state** — `WarRoomCockpit` `PowerDial` and `WarRoomLive` `LeverageBox` each keep independent React state initialized once; changes in one never update the other.
2. **Cockpit `PowerDial`** only reads `configValue` on first mount (`initialized.current` guard).
3. **`LeverageBox`** sync runs only once via `cfgInitialized.current` in `WarRoomLive`.
4. **Cockpit `updateConfig`** mutation did not invalidate `getStatus`, so polling could lag.
5. **`updateConfig`** did not pass `accountSlug` / `runWithTradingAccount`, so multi-book writes could hit the wrong `liveEngineConfig` row.
6. **Range mismatch** — LeverageBox capped overnight at 1.9× while Cockpit allows 0–2.0×.

## Fix

- Bidirectional sync: both controls follow `getStatus().config` after any save.
- Pass `accountSlug` through `updateConfig` and scope DB updates by `tradingAccountId`.
- Align LeverageBox limits with Cockpit (0–4.0 / 0–2.0).

## Verification

1. Open War Room → change INTRADAY POWER slider → bottom מינוף shows same value within one poll.
2. Change מינוף in bottom panel → Cockpit dials match after save.
3. `/war-room/dror` — changes persist to Dror `liveEngineConfig`, not CEO.

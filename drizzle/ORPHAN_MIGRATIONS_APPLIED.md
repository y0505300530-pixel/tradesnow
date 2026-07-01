# Orphan migrations 0134–0145 — journal registration only

**Registered in `meta/_journal.json` on 2026-07-01 (Phase 0).**

These SQL files were applied manually on the live DB before journal registration.
**Do NOT run `drizzle-kit push` or replay ALTER on production.**

| Tag | File | Live DB status |
|-----|------|----------------|
| 0134 | `0134_db_reconcile_toggle.sql` | applied |
| 0135 | `0135_elza_v45_live_toggle.sql` | applied |
| 0136 | `0136_ziv_rotation_flush.sql` | applied |
| 0137 | `0137_snoozed_tickers.sql` | applied |
| 0138 | `0138_elza_intraday_watcher.sql` | applied |
| 0139 | `0139_ghost_slots.sql` | applied |
| 0139 | `0139_ghost_phoenix.sql` | applied |
| 0140 | `0140_phoenix_protocol.sql` | applied |
| 0141 | `0141_armed_watcher_shadow.sql` | applied |
| 0143 | `0143_waiter.sql` | applied |
| 0144 | `0144_selected_team_seed.sql` | applied |
| 0145 | `0145_entry_churn_guard.sql` | applied (4 columns on liveEngineConfig) |

Fresh environments: apply SQL files in order; verify columns exist before starting engine.

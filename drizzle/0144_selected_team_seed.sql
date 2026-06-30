-- SELECTED_TEAM rank-priority seed (owner-ratified 2026-06-30).
-- Stores the 15 owner-picked "selected team" tickers in systemSettings under the
-- key `selected_team` as a JSON array. This is a SORT-ONLY priority list: members
-- get a +0.4 ranking bonus in the War candidates list and the Armed-Watcher top-N.
-- It NEVER touches a gate, sizing, FOMO/anti-chase, gapGuard, combinedGate, or the
-- sector cap. Owner may edit the row's value to change the team.
--
-- IDEMPOTENT: inserts only when the key does not already exist (INSERT IGNORE on the
-- unique `key` column) — re-running this migration never clobbers an owner edit.
INSERT IGNORE INTO `systemSettings` (`key`, `value`)
VALUES (
  'selected_team',
  '["SNDK","MU","INTC","MRVL","AMD","DELL","FLEX","STX","WDC","HUM","DDOG","AMAT","PANW","KLAC","LRCX"]'
);

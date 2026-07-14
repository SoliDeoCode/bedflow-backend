-- Historical sparklines for the Canvas Dashboard (Hospital Snapshot / Occupancy
-- Board / Transaction Board) were always hospital-wide only, even after the
-- Unit toolbar filter was wired into the live counts — the hourly snapshot
-- table had no way to tell rows apart by unit. unit_type NULL = hospital-wide
-- (TOTAL); every operational unit_type also gets its own row each hourly tick.
--
-- Also picks up pending/cancelled, which had no history column at all yet
-- (the "Pending" / "Discharge Cancelled" Transaction Board cards were flat
-- until now).
ALTER TABLE admin_dashboard_snapshots
  ADD COLUMN IF NOT EXISTS unit_type  TEXT    NULL,
  ADD COLUMN IF NOT EXISTS pending    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_admin_dashboard_snapshots_unit_ts
  ON admin_dashboard_snapshots(unit_type, ts);

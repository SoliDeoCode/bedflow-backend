-- Per-payer occupied-bed breakdown captured alongside the existing hourly
-- occupancy snapshot, so the Dashboard's per-payer KPI cards can show a real
-- sparkline. Nullable — old rows have no payer breakdown and are left NULL;
-- there is no way to reconstruct history retroactively.
ALTER TABLE occupancy_snapshots
  ADD COLUMN IF NOT EXISTS payer_snapshot JSONB;

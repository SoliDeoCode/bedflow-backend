-- Hourly history for the new Hospital Snapshot / Occupancy Board / Transaction Board
-- cards that have no equivalent in occupancy_snapshots (which only ever tracked
-- total/vacant/reserved/occupied). Captured on the same hourly tick as
-- occupancy_snapshots — see scheduler/index.ts.
CREATE TABLE IF NOT EXISTS admin_dashboard_snapshots (
  id                         SERIAL  PRIMARY KEY,
  ts                         BIGINT  NOT NULL,
  lounge_patients            INTEGER NOT NULL DEFAULT 0,
  census_daycare             INTEGER NOT NULL DEFAULT 0,
  non_census_daycare         INTEGER NOT NULL DEFAULT 0,
  new_admissions_today       INTEGER NOT NULL DEFAULT 0,
  completed_today            INTEGER NOT NULL DEFAULT 0,
  planned_total              INTEGER NOT NULL DEFAULT 0,
  initiated                  INTEGER NOT NULL DEFAULT 0,
  drug_return_pending        INTEGER NOT NULL DEFAULT 0,
  pharmacy_pending           INTEGER NOT NULL DEFAULT 0,
  procedure_pending          INTEGER NOT NULL DEFAULT 0,
  billing_started            INTEGER NOT NULL DEFAULT 0,
  audit_pending              INTEGER NOT NULL DEFAULT 0,
  bill_ready                 INTEGER NOT NULL DEFAULT 0,
  payment_pending            INTEGER NOT NULL DEFAULT 0,
  system_checkout_pending    INTEGER NOT NULL DEFAULT 0,
  physical_checkout_pending  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_admin_dashboard_snapshots_ts ON admin_dashboard_snapshots(ts);

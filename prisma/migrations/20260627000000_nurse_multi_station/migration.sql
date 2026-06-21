-- Allow a single nurse to be assigned to multiple nursing stations.
-- users.station_id/nursing_station stay as the "primary" station (used for
-- legacy display + JWT), but real access is governed by this join table.
CREATE TABLE IF NOT EXISTS nurse_stations (
  nurse_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id INTEGER NOT NULL REFERENCES nursing_stations(id) ON DELETE CASCADE,
  created_at BIGINT  NOT NULL,
  PRIMARY KEY (nurse_id, station_id)
);
CREATE INDEX IF NOT EXISTS idx_nurse_stations_station ON nurse_stations(station_id);
CREATE INDEX IF NOT EXISTS idx_nurse_stations_nurse   ON nurse_stations(nurse_id);

-- Backfill: every nurse's existing single station becomes their first row here.
INSERT INTO nurse_stations (nurse_id, station_id, created_at)
SELECT id, station_id, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM users
WHERE role = 'NURSE' AND station_id IS NOT NULL
ON CONFLICT DO NOTHING;

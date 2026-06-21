-- Preserve bed_status_updates and ward_operational_log history when a ward is
-- deleted, mirroring the bed_movements fix (20260619000001_bed_movements_history):
-- denormalize ward_name onto each row, then switch the ward_id FK from CASCADE
-- to SET NULL so the row survives deletion (ward_id becomes NULL, ward_name remains).

-- bed_status_updates ──────────────────────────────────────────────────────────
ALTER TABLE bed_status_updates ADD COLUMN IF NOT EXISTS ward_name TEXT;

UPDATE bed_status_updates bsu
SET ward_name = w.name
FROM wards w
WHERE w.id = bsu.ward_id AND bsu.ward_name IS NULL;

ALTER TABLE bed_status_updates ALTER COLUMN ward_id DROP NOT NULL;
ALTER TABLE bed_status_updates DROP CONSTRAINT IF EXISTS bed_status_updates_ward_id_fkey;
ALTER TABLE bed_status_updates
  ADD CONSTRAINT bed_status_updates_ward_id_fkey
  FOREIGN KEY (ward_id) REFERENCES wards(id) ON DELETE SET NULL;

-- ward_operational_log ────────────────────────────────────────────────────────
ALTER TABLE ward_operational_log ADD COLUMN IF NOT EXISTS ward_name TEXT;

UPDATE ward_operational_log wol
SET ward_name = w.name
FROM wards w
WHERE w.id = wol.ward_id AND wol.ward_name IS NULL;

ALTER TABLE ward_operational_log ALTER COLUMN ward_id DROP NOT NULL;
ALTER TABLE ward_operational_log DROP CONSTRAINT IF EXISTS ward_operational_log_ward_id_fkey;
ALTER TABLE ward_operational_log
  ADD CONSTRAINT ward_operational_log_ward_id_fkey
  FOREIGN KEY (ward_id) REFERENCES wards(id) ON DELETE SET NULL;

-- Discharge Lounge stops being identified by matching wards.name = 'Discharge Lounge'
-- (fragile — breaks if anyone renames it) and becomes an explicit flag instead.
-- Partial unique index guarantees at most one ward can ever hold this flag.
ALTER TABLE wards ADD COLUMN IF NOT EXISTS is_discharge_lounge BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_discharge_lounge_ward ON wards (is_discharge_lounge) WHERE is_discharge_lounge = true;

-- Backfill: if a ward named exactly 'Discharge Lounge' already exists (the old
-- convention), flag it now so moveToDischargeLounge keeps working without a manual step.
-- NOTE: this does not touch the ward's existing floor_id — if it was created
-- under a real (or placeholder) floor before this flag existed, it stays there
-- until an admin explicitly detaches/reassigns it.
UPDATE wards SET is_discharge_lounge = true WHERE name = 'Discharge Lounge' AND NOT EXISTS (
  SELECT 1 FROM wards WHERE is_discharge_lounge = true
);

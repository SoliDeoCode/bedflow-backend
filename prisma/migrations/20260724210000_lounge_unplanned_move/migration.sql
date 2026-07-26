-- Tracks "patient physically left" independent of discharge_tracking, since the
-- bed can now move to the Discharge Lounge before any discharge_tracking row
-- exists (manual Bed Transfer into the lounge, no discharge planned/initiated yet).
ALTER TABLE patient_admissions ADD COLUMN IF NOT EXISTS physically_left_at BIGINT;

-- Distinguishes a Readmit (lounge -> real bed) from an ordinary transfer directly
-- in the DB, not just via a free-text reason.
ALTER TABLE bed_transfer_history ADD COLUMN IF NOT EXISTS is_readmit BOOLEAN NOT NULL DEFAULT false;

-- Snapshot payer_type on discharge_tracking so TAT leaderboard can group
-- completed discharges by payer even after the bed has been vacated (at which
-- point bed_details.payer_type is cleared to NULL).
ALTER TABLE discharge_tracking
  ADD COLUMN IF NOT EXISTS payer_type VARCHAR(100) NULL;

-- Best-effort backfill for existing rows: the patient may still be in the same
-- bed, or the bed may have been reassigned.  Rows that can't be resolved stay
-- NULL and appear as "Unknown" in the leaderboard — acceptable for historical data.
UPDATE discharge_tracking dt
SET    payer_type = bd.payer_type
FROM   patient_admissions pa
JOIN   bed_details bd ON bd.id = pa.bed_id
WHERE  pa.id = dt.admission_id
  AND  bd.payer_type IS NOT NULL
  AND  dt.payer_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_discharge_tracking_payer ON discharge_tracking(payer_type);

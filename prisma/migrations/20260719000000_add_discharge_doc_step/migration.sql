-- Add Discharge Summary (DS) as a separate step that runs sequentially
-- after Discharge Initiate (DI) in group 1.
-- DI = discharge_summary_status  (existing, relabelled to "Discharge Initiate")
-- DS = discharge_doc_status       (new, "Discharge Summary" — the doctor's written note)

-- 1. Add the three new columns to discharge_tracking
ALTER TABLE discharge_tracking
  ADD COLUMN IF NOT EXISTS discharge_doc_status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS discharge_doc_started_at   BIGINT,
  ADD COLUMN IF NOT EXISTS discharge_doc_completed_at BIGINT;

-- 2. Shift existing phase sort_orders >= 2 to make room for DS at position 2
UPDATE discharge_phase_config SET sort_order = sort_order + 1 WHERE sort_order >= 2;

-- 3. Insert the new phase config row
INSERT INTO discharge_phase_config (phase_key, label, department, expected_minutes, sort_order, created_at, updated_at)
VALUES (
  'DISCHARGE_DOC', 'Discharge Summary', 'Doctor', 20, 2,
  (EXTRACT(EPOCH FROM now())*1000)::bigint,
  (EXTRACT(EPOCH FROM now())*1000)::bigint
) ON CONFLICT (phase_key) DO NOTHING;

-- 4. Backfill: for in-progress discharges where DI is already completed,
--    start DS now so the SLA clock begins immediately rather than showing NOT_STARTED.
UPDATE discharge_tracking
SET discharge_doc_started_at = COALESCE(
  discharge_doc_started_at,
  discharge_summary_completed_at,
  initiated_at,
  created_at
)
WHERE status IN ('IN_PROGRESS')
  AND discharge_summary_status = 'COMPLETED'
  AND discharge_doc_started_at IS NULL;

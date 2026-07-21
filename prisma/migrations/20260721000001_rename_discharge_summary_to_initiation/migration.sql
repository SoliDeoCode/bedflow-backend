-- Rename the DISCHARGE_SUMMARY step key to DISCHARGE_INITIATION everywhere.

-- 1. Rename the three tracking columns
ALTER TABLE discharge_tracking RENAME COLUMN discharge_summary_status         TO discharge_initiation_status;
ALTER TABLE discharge_tracking RENAME COLUMN discharge_summary_started_at     TO discharge_initiation_started_at;
ALTER TABLE discharge_tracking RENAME COLUMN discharge_summary_completed_at   TO discharge_initiation_completed_at;

-- 2. Update the phase config key + label
UPDATE discharge_phase_config
SET phase_key = 'DISCHARGE_INITIATION', label = 'Discharge Initiation', updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE phase_key = 'DISCHARGE_SUMMARY';

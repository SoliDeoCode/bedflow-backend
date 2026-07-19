-- Rename the DISCHARGE_SUMMARY phase label from 'Discharge Summary'
-- to 'Discharge Initiate' to match the new step naming:
--   DI = Discharge Initiate (discharge_summary_status)
--   DS = Discharge Summary  (discharge_doc_status — added in 20260719000000)
UPDATE discharge_phase_config
SET label      = 'Discharge Initiate',
    updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE phase_key = 'DISCHARGE_SUMMARY';

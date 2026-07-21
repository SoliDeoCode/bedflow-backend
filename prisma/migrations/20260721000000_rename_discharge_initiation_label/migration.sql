UPDATE discharge_phase_config
SET label = 'Discharge Initiation', updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE phase_key = 'DISCHARGE_SUMMARY';

-- Pharmacy Clearance SLA should be 15 min per clinical spec
UPDATE discharge_phase_config SET expected_minutes = 15 WHERE phase_key = 'PHARMACY_CLEARANCE';

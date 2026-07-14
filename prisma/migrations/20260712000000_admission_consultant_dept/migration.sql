-- Optional consultant/department capture at admission time — same manual-entry
-- pattern as ip_last6 (V1: manual entry, HIS integration later). Nullable so it
-- never blocks existing flows or pre-existing (backfilled) admissions.
ALTER TABLE patient_admissions ADD COLUMN IF NOT EXISTS consultant_name VARCHAR(120);
ALTER TABLE patient_admissions ADD COLUMN IF NOT EXISTS department_name VARCHAR(120);

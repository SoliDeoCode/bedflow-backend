-- Admission type (IP / Daycare), captured at admission time alongside ip_last6.
-- Nullable — pre-existing admissions won't have it, same pattern as ip_last6/consultant_name.
ALTER TABLE patient_admissions ADD COLUMN IF NOT EXISTS admission_type VARCHAR(20);

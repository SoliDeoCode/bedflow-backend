-- Add ward-level bed_type and operational defaults
-- All beds generated for a ward will inherit these values.

ALTER TABLE wards ADD COLUMN IF NOT EXISTS bed_type    VARCHAR(20)  NOT NULL DEFAULT 'Census';
ALTER TABLE wards ADD COLUMN IF NOT EXISTS operational BOOLEAN      NOT NULL DEFAULT TRUE;

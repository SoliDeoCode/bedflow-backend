-- Add AC/Non-AC status to individual beds and ward default
ALTER TABLE bed_details ADD COLUMN IF NOT EXISTS ac_status BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE wards       ADD COLUMN IF NOT EXISTS ac        BOOLEAN NOT NULL DEFAULT TRUE;

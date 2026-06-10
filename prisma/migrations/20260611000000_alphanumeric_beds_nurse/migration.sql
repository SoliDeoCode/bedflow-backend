-- ── Alphanumeric bed names + Nurse In-Charge role ────────────────────────────

-- 1. Rename bed_number → bed_name (drop old unique index, rename column, recreate)
DROP INDEX IF EXISTS "bed_details_ward_id_bed_number_key";
ALTER TABLE bed_details RENAME COLUMN bed_number TO bed_name;
CREATE UNIQUE INDEX "bed_details_ward_id_bed_name_key" ON "bed_details"("ward_id", "bed_name");

-- 2. Add bed-level master fields to bed_details
ALTER TABLE bed_details ADD COLUMN IF NOT EXISTS bed_type          VARCHAR(50)  NOT NULL DEFAULT 'Census';
ALTER TABLE bed_details ADD COLUMN IF NOT EXISTS operational_status BOOLEAN      NOT NULL DEFAULT TRUE;

-- 3. Add ward-level master fields to wards
ALTER TABLE wards ADD COLUMN IF NOT EXISTS nursing_station VARCHAR(100);
ALTER TABLE wards ADD COLUMN IF NOT EXISTS unit_type       VARCHAR(100);
ALTER TABLE wards ADD COLUMN IF NOT EXISTS room_type       VARCHAR(100);

-- 4. Add NURSE role + nursing_station column to users
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('PRE','MANAGER','COO','NURSE'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS nursing_station VARCHAR(100);

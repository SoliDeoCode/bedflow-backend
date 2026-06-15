-- Preserve bed movement history when a bed is deleted.
--
-- Previously bed_movements.bed_id had ON DELETE CASCADE, meaning deleting
-- a bed wiped its entire movement history. This migration:
--   1. Adds bed_name and ward_id directly to bed_movements so history is
--      queryable even after the bed row is gone.
--   2. Makes bed_id nullable and changes FK to ON DELETE SET NULL so rows
--      survive bed deletion (bed_id becomes NULL, bed_name/ward_id remain).

-- Step 1: add columns to carry identity after the bed row is deleted
ALTER TABLE bed_movements
  ADD COLUMN IF NOT EXISTS bed_name TEXT,
  ADD COLUMN IF NOT EXISTS ward_id  INT;

-- Step 2: back-fill existing rows from bed_details (beds that still exist)
UPDATE bed_movements bm
SET bed_name = bd.bed_name,
    ward_id  = bd.ward_id
FROM bed_details bd
WHERE bd.id = bm.bed_id;

-- Step 3: make bed_id nullable (so SET NULL can work on delete)
ALTER TABLE bed_movements
  ALTER COLUMN bed_id DROP NOT NULL;

-- Step 4: drop the CASCADE constraint and replace with SET NULL
ALTER TABLE bed_movements
  DROP CONSTRAINT bed_movements_bed_id_fkey;

ALTER TABLE bed_movements
  ADD CONSTRAINT bed_movements_bed_id_fkey
  FOREIGN KEY (bed_id) REFERENCES bed_details(id) ON DELETE SET NULL;

-- Step 5: index for fast history lookups by ward or bed name
CREATE INDEX IF NOT EXISTS idx_bed_movements_ward    ON bed_movements(ward_id);
CREATE INDEX IF NOT EXISTS idx_bed_movements_bedname ON bed_movements(bed_name);

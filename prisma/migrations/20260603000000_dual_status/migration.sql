-- Dual-status migration: split single `status` into `physical_status` + `reservation_status`
--
-- Data mapping (zero data loss):
--   VACANT   → physical='VACANT',   reservation='NONE'
--   RESERVED → physical='VACANT',   reservation='RESERVED'
--   OCCUPIED → physical='OCCUPIED', reservation='NONE'
--
-- New combination only possible going forward:
--   OCCUPIED + RESERVED → physical='OCCUPIED', reservation='RESERVED'

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. bed_details: add new columns with defaults so existing 225 rows are valid,
--    migrate old status values, then drop the old column.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE "bed_details" ADD COLUMN "physical_status"    VARCHAR(20) NOT NULL DEFAULT 'VACANT';
ALTER TABLE "bed_details" ADD COLUMN "reservation_status" VARCHAR(20) NOT NULL DEFAULT 'NONE';

-- Migrate existing data
UPDATE "bed_details" SET
  "physical_status"    = CASE WHEN "status" = 'OCCUPIED' THEN 'OCCUPIED' ELSE 'VACANT' END,
  "reservation_status" = CASE WHEN "status" = 'RESERVED' THEN 'RESERVED' ELSE 'NONE' END;

-- Drop old column
ALTER TABLE "bed_details" DROP COLUMN "status";

-- Update the index
DROP INDEX IF EXISTS "idx_bed_details_ward";
CREATE INDEX "idx_bed_details_ward" ON "bed_details"("ward_id", "physical_status", "reservation_status");

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. bed_movements: add new columns as nullable, backfill, then enforce NOT NULL.
--    Cannot add NOT NULL without default when rows exist, so we do it in steps.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE "bed_movements" ADD COLUMN "old_physical"    VARCHAR(20);
ALTER TABLE "bed_movements" ADD COLUMN "new_physical"    VARCHAR(20);
ALTER TABLE "bed_movements" ADD COLUMN "old_reservation" VARCHAR(20);
ALTER TABLE "bed_movements" ADD COLUMN "new_reservation" VARCHAR(20);

-- Backfill from old status columns
UPDATE "bed_movements" SET
  "old_physical"    = CASE WHEN "old_status" = 'OCCUPIED' THEN 'OCCUPIED' ELSE 'VACANT' END,
  "new_physical"    = CASE WHEN "new_status" = 'OCCUPIED' THEN 'OCCUPIED' ELSE 'VACANT' END,
  "old_reservation" = CASE WHEN "old_status" = 'RESERVED' THEN 'RESERVED' ELSE 'NONE' END,
  "new_reservation" = CASE WHEN "new_status" = 'RESERVED' THEN 'RESERVED' ELSE 'NONE' END;

-- Enforce NOT NULL now that all rows have values
ALTER TABLE "bed_movements" ALTER COLUMN "old_physical"    SET NOT NULL;
ALTER TABLE "bed_movements" ALTER COLUMN "new_physical"    SET NOT NULL;
ALTER TABLE "bed_movements" ALTER COLUMN "old_reservation" SET NOT NULL;
ALTER TABLE "bed_movements" ALTER COLUMN "new_reservation" SET NOT NULL;

-- Drop old columns
ALTER TABLE "bed_movements" DROP COLUMN "old_status";
ALTER TABLE "bed_movements" DROP COLUMN "new_status";

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. beds summary table: add occupied_reserved column (nullable, starts at 0)
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE "beds" ADD COLUMN "occupied_reserved" INTEGER;

-- Initialise from bed_details so the summary is correct immediately
UPDATE "beds" b SET "occupied_reserved" = (
  SELECT COUNT(*) FROM "bed_details" bd
  WHERE bd.ward_id = b.ward_id
    AND bd.physical_status = 'OCCUPIED'
    AND bd.reservation_status = 'RESERVED'
);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. bed_status_updates: rename columns to reflect the new 4-state model.
--    Uses nullable temp approach so existing rows survive.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE "bed_status_updates" ADD COLUMN "vacant_none"       INTEGER;
ALTER TABLE "bed_status_updates" ADD COLUMN "vacant_reserved"   INTEGER;
ALTER TABLE "bed_status_updates" ADD COLUMN "occupied_none"     INTEGER;
ALTER TABLE "bed_status_updates" ADD COLUMN "occupied_reserved" INTEGER;

-- Migrate: old "vacant" → vacant_none, old "reserved" → vacant_reserved,
--          old "occupied" → occupied_none, new occupied_reserved = 0
UPDATE "bed_status_updates" SET
  "vacant_none"       = COALESCE("vacant",   0),
  "vacant_reserved"   = COALESCE("reserved", 0),
  "occupied_none"     = COALESCE("occupied", 0),
  "occupied_reserved" = 0;

-- Enforce NOT NULL
ALTER TABLE "bed_status_updates" ALTER COLUMN "vacant_none"       SET NOT NULL;
ALTER TABLE "bed_status_updates" ALTER COLUMN "vacant_reserved"   SET NOT NULL;
ALTER TABLE "bed_status_updates" ALTER COLUMN "occupied_none"     SET NOT NULL;
ALTER TABLE "bed_status_updates" ALTER COLUMN "occupied_reserved" SET NOT NULL;

-- Drop old columns
ALTER TABLE "bed_status_updates" DROP COLUMN "vacant";
ALTER TABLE "bed_status_updates" DROP COLUMN "reserved";
ALTER TABLE "bed_status_updates" DROP COLUMN "occupied";

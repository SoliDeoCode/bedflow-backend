-- ── Block → Floor → Ward hierarchy + first-class Nursing Stations ─────────────
--
-- What this migration does:
--   1. Extends the (empty) floors table into a real entity linked to block group A/B
--   2. Adds floor_id to the blocks (section) table so sections know which floor they're on
--   3. Creates nursing_stations as a first-class table (replaces free-text string)
--   4. Migrates existing wards.nursing_station strings → station rows → station_id FK
--   5. Migrates users.nursing_station strings → station_id FK (NURSE users)
--   6. Adds wards.default_bed_type and wards.operational (ward-level master defaults)
--
-- All changes are additive or backfilled — zero data loss.

-- ── 1. Extend floors table ────────────────────────────────────────────────────
-- Remove old unique constraint (name alone — conflicts once we have Block A/Block B floors)
DROP INDEX IF EXISTS "floors_name_key";

ALTER TABLE floors ADD COLUMN IF NOT EXISTS block_label  VARCHAR(5)  NOT NULL DEFAULT 'A';
ALTER TABLE floors ADD COLUMN IF NOT EXISTS code         VARCHAR(20);
ALTER TABLE floors ADD COLUMN IF NOT EXISTS sort_order   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE floors ADD COLUMN IF NOT EXISTS created_at   BIGINT;
ALTER TABLE floors ADD COLUMN IF NOT EXISTS updated_at   BIGINT;

-- Unique: same floor code can appear in Block A and Block B separately
CREATE UNIQUE INDEX IF NOT EXISTS floors_code_label_key ON floors(code, block_label);

-- ── 2. Populate floors from current blocks (extract floor prefix + group label) ─
-- e.g. "GF Emergency" label "A" → code "GF", name "Ground Floor", block_label "A"
--      "3F MICU I"    label "A" → code "3F", name "3rd Floor",    block_label "A"
-- Only blocks whose first word matches the floor-code pattern are processed.

INSERT INTO floors (name, code, block_label, sort_order, created_at, updated_at)
SELECT DISTINCT
  CASE code
    WHEN 'GF'  THEN 'Ground Floor'
    WHEN 'BF'  THEN 'Basement Floor'
    WHEN '1F'  THEN '1st Floor'
    WHEN '2F'  THEN '2nd Floor'
    WHEN '3F'  THEN '3rd Floor'
    WHEN '4F'  THEN '4th Floor'
    WHEN '5F'  THEN '5th Floor'
    WHEN '6F'  THEN '6th Floor'
    ELSE code || ' Floor'
  END,
  code,
  COALESCE(block_label, 'A'),
  CASE code
    WHEN 'BF' THEN -1
    WHEN 'GF' THEN 0
    WHEN '1F' THEN 1
    WHEN '2F' THEN 2
    WHEN '3F' THEN 3
    WHEN '4F' THEN 4
    WHEN '5F' THEN 5
    WHEN '6F' THEN 6
    ELSE 99
  END,
  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
FROM (
  SELECT
    UPPER(SPLIT_PART(TRIM(name), ' ', 1)) AS code,
    UPPER(COALESCE(label, 'A'))            AS block_label
  FROM blocks
) sub
WHERE code ~ '^(GF|BF|[0-9]+F)$'
ON CONFLICT (code, block_label) DO NOTHING;

-- ── 3. Add floor_id to blocks — link each section to its floor ────────────────
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS floor_id INTEGER REFERENCES floors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_floor_id ON blocks(floor_id);

UPDATE blocks b
SET    floor_id = f.id
FROM   floors f
WHERE  f.block_label = UPPER(COALESCE(b.label, 'A'))
  AND  f.code        = UPPER(SPLIT_PART(TRIM(b.name), ' ', 1))
  AND  UPPER(SPLIT_PART(TRIM(b.name), ' ', 1)) ~ '^(GF|BF|[0-9]+F)$';

-- ── 4. Create nursing_stations table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nursing_stations (
  id         SERIAL PRIMARY KEY,
  name       TEXT   NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Seed from every distinct non-empty nursing_station string in wards
INSERT INTO nursing_stations (name, created_at, updated_at)
SELECT DISTINCT
  TRIM(nursing_station),
  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
FROM wards
WHERE nursing_station IS NOT NULL
  AND TRIM(nursing_station) <> ''
ON CONFLICT (name) DO NOTHING;

-- ── 5. Add station_id FK to wards ─────────────────────────────────────────────
ALTER TABLE wards ADD COLUMN IF NOT EXISTS station_id INTEGER REFERENCES nursing_stations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_wards_station_id ON wards(station_id);

UPDATE wards w
SET    station_id = ns.id
FROM   nursing_stations ns
WHERE  TRIM(ns.name) = TRIM(w.nursing_station)
  AND  w.nursing_station IS NOT NULL;

-- ── 6. Add station_id FK to users (NURSE role) ───────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS station_id INTEGER REFERENCES nursing_stations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_station_id ON users(station_id);

UPDATE users u
SET    station_id = ns.id
FROM   nursing_stations ns
WHERE  TRIM(ns.name) = TRIM(u.nursing_station)
  AND  u.role = 'NURSE'
  AND  u.nursing_station IS NOT NULL;

-- ── 7. Ward-level master defaults ─────────────────────────────────────────────
ALTER TABLE wards ADD COLUMN IF NOT EXISTS default_bed_type VARCHAR(50) NOT NULL DEFAULT 'Census';
ALTER TABLE wards ADD COLUMN IF NOT EXISTS operational       BOOLEAN     NOT NULL DEFAULT TRUE;

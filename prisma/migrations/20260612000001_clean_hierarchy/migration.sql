-- ── Clean-slate hierarchy: building_blocks → floors → wards → beds ─────────────
-- PRE users assigned to floors; wards link directly to floors (not old sections).
-- All operational data is truncated — credentials are preserved.

-- 1. Building blocks (Block A, Block B …)
CREATE TABLE IF NOT EXISTS building_blocks (
  id         SERIAL       PRIMARY KEY,
  name       VARCHAR(50)  NOT NULL UNIQUE,   -- 'A', 'B'
  label      VARCHAR(100),                    -- 'Block A', 'Block B'
  sort_order INTEGER      NOT NULL DEFAULT 0,
  created_at BIGINT       NOT NULL,
  updated_at BIGINT       NOT NULL
);

-- 2. Floors now belong to a building block
ALTER TABLE floors ADD COLUMN IF NOT EXISTS building_block_id INTEGER REFERENCES building_blocks(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_floors_bblock ON floors(building_block_id);

-- 3. Wards get floor_id — direct link to floor, bypasses old sections table
ALTER TABLE wards ADD COLUMN IF NOT EXISTS floor_id INTEGER REFERENCES floors(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_wards_floor_id ON wards(floor_id);

-- 4. PRE users are now assigned to a floor
ALTER TABLE users ADD COLUMN IF NOT EXISTS floor_id INTEGER REFERENCES floors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_floor_id ON users(floor_id);

-- 5. pre_rounds record which floor the round was submitted for
ALTER TABLE pre_rounds ADD COLUMN IF NOT EXISTS floor_id INTEGER REFERENCES floors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pre_rounds_floor_id ON pre_rounds(floor_id);

-- 6. Clear all user assignments (keep login credentials)
UPDATE users
SET block_id        = NULL,
    floor_id        = NULL,
    nursing_station = NULL,
    station_id      = NULL;

-- 7. Truncate all operational data (fresh start)
--    Users table is intentionally excluded — managers keep their logins.
TRUNCATE TABLE
  pre_rounds, bed_status_updates, bed_details, beds, wards,
  nursing_stations, floors, blocks, building_blocks,
  occupancy_snapshots, saved_views
RESTART IDENTITY CASCADE;

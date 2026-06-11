-- PRE Blocks: logical groupings of wards for PRE workflow/reporting
-- Separate from physical Block A/B/C hierarchy.

CREATE TABLE IF NOT EXISTS pre_blocks (
  id          SERIAL        PRIMARY KEY,
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  status      VARCHAR(20)   NOT NULL DEFAULT 'active',
  created_by  INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  created_at  BIGINT        NOT NULL,
  updated_at  BIGINT        NOT NULL,
  CONSTRAINT pre_blocks_name_unique UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS pre_block_wards (
  id           SERIAL  PRIMARY KEY,
  pre_block_id INTEGER NOT NULL REFERENCES pre_blocks(id) ON DELETE CASCADE,
  ward_id      INTEGER NOT NULL REFERENCES wards(id)      ON DELETE CASCADE,
  created_at   BIGINT  NOT NULL,
  UNIQUE(pre_block_id, ward_id)
);

CREATE INDEX IF NOT EXISTS idx_pre_block_wards_block ON pre_block_wards(pre_block_id);
CREATE INDEX IF NOT EXISTS idx_pre_block_wards_ward  ON pre_block_wards(ward_id);

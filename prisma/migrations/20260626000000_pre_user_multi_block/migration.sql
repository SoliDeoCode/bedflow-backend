-- Replace single users.pre_block_id with a many-to-many junction table so
-- each PRE user can be assigned to multiple PRE Blocks simultaneously.

CREATE TABLE IF NOT EXISTS user_pre_blocks (
  user_id      INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  pre_block_id INTEGER NOT NULL REFERENCES pre_blocks(id)  ON DELETE CASCADE,
  created_at   BIGINT  NOT NULL,
  PRIMARY KEY (user_id, pre_block_id)
);

CREATE INDEX IF NOT EXISTS idx_user_pre_blocks_user  ON user_pre_blocks(user_id);
CREATE INDEX IF NOT EXISTS idx_user_pre_blocks_block ON user_pre_blocks(pre_block_id);

-- Migrate existing single-block assignments into the junction table
INSERT INTO user_pre_blocks (user_id, pre_block_id, created_at)
SELECT id, pre_block_id, updated_at
FROM users
WHERE pre_block_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Drop the now-redundant scalar column
ALTER TABLE users DROP COLUMN IF EXISTS pre_block_id;

-- PRE users are now assigned to PRE Blocks (not physical floors).
-- pre_block_id replaces floor_id for PRE user assignment.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pre_block_id INTEGER
  REFERENCES pre_blocks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_pre_block_id ON users(pre_block_id);

-- pre_rounds tracks which PRE Block the round was submitted for
ALTER TABLE pre_rounds
  ADD COLUMN IF NOT EXISTS pre_block_id INTEGER
  REFERENCES pre_blocks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pre_rounds_pre_block_id ON pre_rounds(pre_block_id);

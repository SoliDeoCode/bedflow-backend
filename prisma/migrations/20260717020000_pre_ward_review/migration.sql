-- Per-ward "reviewed, nothing to update" stamp for PRE — mirrors doctor_block_reviews'
-- ward-level review exactly, but scoped to pre_blocks instead of doctor_blocks.
-- Independent of round submission (pre_rounds): a PRE can mark a ward checked
-- without it counting toward the round-alarm's "all wards submitted" gate.
CREATE TABLE IF NOT EXISTS pre_ward_reviews (
  id            SERIAL  PRIMARY KEY,
  pre_block_id  INTEGER NOT NULL REFERENCES pre_blocks(id) ON DELETE CASCADE,
  ward_id       INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pre_ward_reviews_block ON pre_ward_reviews(pre_block_id);
CREATE INDEX IF NOT EXISTS idx_pre_ward_reviews_ward  ON pre_ward_reviews(ward_id);

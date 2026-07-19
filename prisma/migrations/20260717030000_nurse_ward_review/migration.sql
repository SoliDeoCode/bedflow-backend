-- Per-ward "reviewed, nothing to update" stamp for Nurse — mirrors
-- pre_ward_reviews / doctor_block_reviews exactly, scoped to the ward itself
-- (a nurse's access isn't block-based, so no parent-id column like the other
-- two — just ward_id + user_id + reviewed_at).
CREATE TABLE IF NOT EXISTS nurse_ward_reviews (
  id            SERIAL  PRIMARY KEY,
  ward_id       INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nurse_ward_reviews_ward ON nurse_ward_reviews(ward_id);

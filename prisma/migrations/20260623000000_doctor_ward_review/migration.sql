-- Allow a doctor review-confirm to target a single ward (ward_id set) in
-- addition to the existing block-wide review (ward_id NULL = the whole block).
ALTER TABLE doctor_block_reviews
  ADD COLUMN IF NOT EXISTS ward_id INTEGER REFERENCES wards(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_doctor_block_reviews_ward ON doctor_block_reviews(ward_id);

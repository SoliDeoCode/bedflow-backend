-- Add PHARMACY and MASTER_PHARMACY roles for pharmacy staff, and
-- MASTER_FC as the supervisory FC role.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role::text = ANY (ARRAY[
    'PRE','COO','NURSE','DOCTOR','FC','CONSULTANT',
    'PHARMACY','MASTER_PHARMACY','MASTER_FC'
  ]::text[]));

-- Reopen requests — PHARMACY users request step reopens; MASTER_PHARMACY reviews.
CREATE TABLE IF NOT EXISTS reopen_requests (
  id              BIGSERIAL PRIMARY KEY,
  tracking_id     BIGINT NOT NULL REFERENCES discharge_tracking(id),
  admission_id    BIGINT NOT NULL,
  step_key        TEXT NOT NULL,
  requested_by    BIGINT NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DENIED')),
  reviewed_by     BIGINT REFERENCES users(id),
  review_note     TEXT,
  created_at      BIGINT NOT NULL,
  reviewed_at     BIGINT,
  ward_name       TEXT,
  bed_name        TEXT
);
CREATE INDEX IF NOT EXISTS idx_reopen_requests_status ON reopen_requests(status);
CREATE INDEX IF NOT EXISTS idx_reopen_requests_tracking ON reopen_requests(tracking_id);

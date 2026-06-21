-- ── Doctor role + block-based access (many-to-many) + per-bed update audit ──────
-- Doctors update individual beds inside their assigned Doctor Blocks; every
-- change syncs live through the existing bed_movements/socket pipeline. Doctors
-- do NOT run PRE rounds, alarms, schedules or reminders — they can only
-- "review-confirm" their wards (a manual last-reviewed stamp).

-- 1. Allow the DOCTOR role.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('PRE','COO','NURSE','DOCTOR'));

-- 2. Account status + remarks. Default 'active' so existing accounts are
--    unaffected; doctor management uses these, and login now rejects inactive
--    accounts for every role.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status  VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active','inactive'));

-- 3. Doctor Blocks — logical ward groupings for the doctor workflow
--    (independent of physical Block A/B/C and of PRE Blocks).
CREATE TABLE IF NOT EXISTS doctor_blocks (
  id          SERIAL       PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active',
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  CONSTRAINT doctor_blocks_name_unique  UNIQUE (name),
  CONSTRAINT doctor_blocks_status_check CHECK (status IN ('active','inactive'))
);

-- A ward belongs to AT MOST ONE Doctor Block — enforced by UNIQUE(ward_id).
CREATE TABLE IF NOT EXISTS doctor_block_wards (
  id              SERIAL  PRIMARY KEY,
  doctor_block_id INTEGER NOT NULL REFERENCES doctor_blocks(id) ON DELETE CASCADE,
  ward_id         INTEGER NOT NULL REFERENCES wards(id)         ON DELETE CASCADE,
  created_at      BIGINT  NOT NULL,
  CONSTRAINT doctor_block_wards_ward_unique UNIQUE (ward_id)
);

-- Doctor ↔ Block many-to-many. A doctor may belong to many blocks; a block may
-- hold many doctors. No doctor_block_id is stored on the users table.
CREATE TABLE IF NOT EXISTS doctor_block_users (
  id              SERIAL  PRIMARY KEY,
  doctor_block_id INTEGER NOT NULL REFERENCES doctor_blocks(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  created_at      BIGINT  NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT doctor_block_users_unique UNIQUE (doctor_block_id, user_id)
);

-- Per-bed change audit specific to doctor updates (captures ip/device), kept in
-- addition to the shared bed_movements history that feeds dashboards/analytics.
CREATE TABLE IF NOT EXISTS doctor_activity_logs (
  id              SERIAL  PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id)         ON DELETE SET NULL,
  doctor_block_id INTEGER REFERENCES doctor_blocks(id) ON DELETE SET NULL,
  ward_id         INTEGER REFERENCES wards(id)         ON DELETE SET NULL,
  bed_id          INTEGER REFERENCES bed_details(id)   ON DELETE SET NULL,
  bed_name        VARCHAR(120),
  old_physical    VARCHAR(20),
  new_physical    VARCHAR(20),
  old_reservation VARCHAR(20),
  new_reservation VARCHAR(20),
  ip_address      VARCHAR(64),
  device_info     TEXT,
  created_at      BIGINT  NOT NULL
);

-- Doctor "review-confirm" — stamps a last-reviewed time over a block's wards,
-- mirroring the PRE round 'reviewed' signal the Admin dashboard surfaces.
CREATE TABLE IF NOT EXISTS doctor_block_reviews (
  id              SERIAL  PRIMARY KEY,
  doctor_block_id INTEGER NOT NULL REFERENCES doctor_blocks(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doctor_block_wards_block   ON doctor_block_wards(doctor_block_id);
CREATE INDEX IF NOT EXISTS idx_doctor_block_wards_ward    ON doctor_block_wards(ward_id);
CREATE INDEX IF NOT EXISTS idx_doctor_block_users_block   ON doctor_block_users(doctor_block_id);
CREATE INDEX IF NOT EXISTS idx_doctor_block_users_user    ON doctor_block_users(user_id);
CREATE INDEX IF NOT EXISTS idx_doctor_activity_user       ON doctor_activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_doctor_activity_bed        ON doctor_activity_logs(bed_id);
CREATE INDEX IF NOT EXISTS idx_doctor_activity_created    ON doctor_activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_doctor_block_reviews_block ON doctor_block_reviews(doctor_block_id);

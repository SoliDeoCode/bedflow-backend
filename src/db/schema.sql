-- BedFlow schema (SQLite dialect; PostgreSQL-compatible structure).
-- Enums are enforced via CHECK constraints (portable to Postgres ENUM later).
-- All timestamps are epoch milliseconds (INTEGER) for timezone-safe storage.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('PRE','COO','NURSE','DOCTOR')),
  name          TEXT NOT NULL,
  shift         TEXT NOT NULL DEFAULT 'morning' CHECK (shift IN ('morning','night')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  remarks       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Kept for migration compatibility only — superseded by blocks below
CREATE TABLE IF NOT EXISTS floors (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

-- ── NEW: blocks replace floors + pre_code ─────────────────────────────────────
-- name      = canonical short code, e.g. "1A", "2B" (TRIM + UPPER enforced in app)
-- name_key  = UPPER(TRIM(name)) — dedup/lookup key
-- label     = optional long display name e.g. "Oncology Wing"
-- sort_order= manager-controlled display sequence
CREATE TABLE IF NOT EXISTS blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  name_key    TEXT    NOT NULL UNIQUE,
  label       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_key ON blocks(name_key);

CREATE TABLE IF NOT EXISTS wards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  -- block_id is the single source of truth (floor_id + pre_code are legacy)
  -- NOTE: block_id is added via addColumnIfMissing on existing DBs (migrate.ts step 2)
  total_beds  INTEGER NOT NULL CHECK (total_beds >= 0),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
  -- block_id, floor_id, pre_code added via ALTER TABLE in migrate.ts
  -- so indexes on those columns are also created in migrate.ts (not here)
);

-- live bed counts per ward (one row per ward; the current snapshot)
CREATE TABLE IF NOT EXISTS beds (
  ward_id    INTEGER PRIMARY KEY REFERENCES wards(id) ON DELETE CASCADE,
  total      INTEGER NOT NULL,
  vacant     INTEGER,                     -- NULL until first entry (no demo data)
  reserved   INTEGER,
  occupied   INTEGER,                     -- auto-calculated = total - vacant - reserved
  updated_at INTEGER,
  updated_by INTEGER REFERENCES users(id)
);

-- Kept for migration compatibility — superseded by users.block_id
CREATE TABLE IF NOT EXISTS pre_assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pre_code   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, pre_code)
);
CREATE INDEX IF NOT EXISTS idx_assign_user ON pre_assignments(user_id);

-- immutable log of every bed count change
CREATE TABLE IF NOT EXISTS bed_status_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ward_id    INTEGER REFERENCES wards(id) ON DELETE SET NULL,
  ward_name  TEXT,
  vacant     INTEGER NOT NULL,
  reserved   INTEGER NOT NULL,
  occupied   INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bsu_ward ON bed_status_updates(ward_id, created_at);

-- one row per completed 2-hour round submission
CREATE TABLE IF NOT EXISTS pre_rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pre_code     TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  shift        TEXT NOT NULL,
  round_key    TEXT NOT NULL UNIQUE,      -- pre|shift|YYYY-MM-DD|startMin
  start_min    INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  snapshot     TEXT                       -- JSON of ward counts at submit time
);
CREATE INDEX IF NOT EXISTS idx_rounds_pre ON pre_rounds(pre_code, submitted_at);

-- recurring reminder definitions + state
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_role TEXT NOT NULL CHECK (target_role IN ('PRE','COO')),
  interval_min INTEGER NOT NULL,
  window_start TEXT NOT NULL,             -- 'HH:MM'
  window_end   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,       -- 'morning' | 'night'
  label       TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL
);

-- immutable audit trail of all significant actions
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);

-- periodic hospital-wide occupancy snapshots (for charts/history)
CREATE TABLE IF NOT EXISTS occupancy_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  total          INTEGER NOT NULL,
  vacant         INTEGER NOT NULL,
  reserved       INTEGER NOT NULL,
  occupied       INTEGER NOT NULL,
  payer_snapshot TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON occupancy_snapshots(ts);

-- web-push subscriptions per user/device
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  sub_json   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- individual bed tracking (bed_details is the source of truth; beds table is the summary)
CREATE TABLE IF NOT EXISTS bed_details (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ward_id    INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  bed_number TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('VACANT','RESERVED','OCCUPIED')),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  UNIQUE(ward_id, bed_number)
);
CREATE INDEX IF NOT EXISTS idx_bed_details_ward ON bed_details(ward_id, status);

-- immutable log of every individual bed status change
CREATE TABLE IF NOT EXISTS bed_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bed_id     INTEGER NOT NULL REFERENCES bed_details(id) ON DELETE CASCADE,
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bed_movements_bed ON bed_movements(bed_id, changed_at);

import { db } from "./index.js";

// Schema is inlined so it works regardless of file-system layout (dev tsx / prod dist/).
const SCHEMA_SQL = `
-- BedFlow schema (SQLite dialect; PostgreSQL-compatible structure).
-- All timestamps are epoch milliseconds (INTEGER) for timezone-safe storage.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('PRE','MANAGER','COO')),
  name          TEXT NOT NULL,
  shift         TEXT NOT NULL DEFAULT 'morning' CHECK (shift IN ('morning','night')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Kept for migration compatibility only — superseded by blocks below
CREATE TABLE IF NOT EXISTS floors (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

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

-- wards: block_id, floor_id, pre_code added via ALTER TABLE in migrate() below
CREATE TABLE IF NOT EXISTS wards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  total_beds  INTEGER NOT NULL CHECK (total_beds >= 0),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS beds (
  ward_id    INTEGER PRIMARY KEY REFERENCES wards(id) ON DELETE CASCADE,
  total      INTEGER NOT NULL,
  vacant     INTEGER,
  reserved   INTEGER,
  occupied   INTEGER,
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

CREATE TABLE IF NOT EXISTS bed_status_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ward_id    INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  vacant     INTEGER NOT NULL,
  reserved   INTEGER NOT NULL,
  occupied   INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bsu_ward ON bed_status_updates(ward_id, created_at);

CREATE TABLE IF NOT EXISTS pre_rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pre_code     TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  shift        TEXT NOT NULL,
  round_key    TEXT NOT NULL UNIQUE,
  start_min    INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  snapshot     TEXT
);
CREATE INDEX IF NOT EXISTS idx_rounds_pre ON pre_rounds(pre_code, submitted_at);

CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_role TEXT NOT NULL CHECK (target_role IN ('PRE','COO')),
  interval_min INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);

CREATE TABLE IF NOT EXISTS occupancy_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  vacant     INTEGER NOT NULL,
  reserved   INTEGER NOT NULL,
  occupied   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON occupancy_snapshots(ts);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  sub_json   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`;

export function migrate(): void {
  // ── Step 1: run base schema (CREATE TABLE IF NOT EXISTS — all idempotent) ──
  db.exec(SCHEMA_SQL);

  // ── Step 2: add new columns to existing tables (idempotent) ───────────────
  // wards: block_id is the new FK; floor_id + pre_code kept for migration data
  addColumnIfMissing("wards",      "block_id",
    "INTEGER REFERENCES blocks(id) ON DELETE RESTRICT");
  addColumnIfMissing("wards",      "floor_id",
    "INTEGER REFERENCES floors(id) ON DELETE SET NULL");
  addColumnIfMissing("wards",      "pre_code", "TEXT");
  addColumnIfMissing("users",      "block_id",
    "INTEGER REFERENCES blocks(id) ON DELETE SET NULL");
  addColumnIfMissing("pre_rounds", "block_id",
    "INTEGER REFERENCES blocks(id)");

  // Create indexes on ward columns — done here (after columns exist) not in schema.sql
  db.exec("CREATE INDEX IF NOT EXISTS idx_wards_block ON wards(block_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_wards_pre   ON wards(pre_code)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_wards_floor ON wards(floor_id)");

  // ── Step 3: one-time migration from floors / pre_assignments → blocks ──────
  runV2Migration();
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Migrate floor rows → blocks, then wire wards + users to blocks. Safe to call
 *  multiple times — each UPDATE only touches rows where block_id IS NULL. */
function runV2Migration() {
  const now = Date.now();

  db.transaction(() => {
    // 3a. Seed blocks from the floors table (keep names, manager renames later)
    const floors = db.prepare(
      "SELECT id, name FROM floors"
    ).all<{ id: number; name: string }>();

    const insBlock = db.prepare(
      `INSERT OR IGNORE INTO blocks (name, name_key, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    let order = 0;
    for (const f of floors) {
      const trimmed = f.name.trim();
      insBlock.run(trimmed, trimmed.toUpperCase(), ++order, now, now);
    }

    // 3b. Wire wards.block_id from wards.floor_id (only rows not yet wired)
    db.exec(`
      UPDATE wards
      SET    block_id = (
               SELECT b.id FROM blocks b
               JOIN   floors f ON UPPER(TRIM(f.name)) = b.name_key
               WHERE  f.id = wards.floor_id
             )
      WHERE  block_id IS NULL
      AND    floor_id IS NOT NULL
    `);

    // 3c. Wire users.block_id from pre_assignments → wards (for PRE users)
    db.exec(`
      UPDATE users
      SET    block_id = (
               SELECT w.block_id
               FROM   pre_assignments pa
               JOIN   wards w ON w.pre_code = pa.pre_code AND w.block_id IS NOT NULL
               WHERE  pa.user_id = users.id
               LIMIT  1
             )
      WHERE  role      = 'PRE'
      AND    block_id  IS NULL
    `);

    // 3d. Wire pre_rounds.block_id from the submitting user's block
    db.exec(`
      UPDATE pre_rounds
      SET    block_id = (
               SELECT u.block_id
               FROM   users u
               WHERE  u.id = pre_rounds.user_id AND u.block_id IS NOT NULL
             )
      WHERE  block_id IS NULL
      AND    user_id  IS NOT NULL
    `);
  });
}

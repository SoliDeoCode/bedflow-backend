import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./index.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function migrate() {
    // ── Step 1: run base schema (CREATE TABLE IF NOT EXISTS) ──────────────────
    const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
    db.exec(schema);
    // ── Step 2: add new columns to existing tables (idempotent) ───────────────
    // wards: block_id is the new FK; floor_id + pre_code kept for migration data
    addColumnIfMissing("wards", "block_id", "INTEGER REFERENCES blocks(id) ON DELETE RESTRICT");
    addColumnIfMissing("wards", "floor_id", "INTEGER REFERENCES floors(id) ON DELETE SET NULL");
    addColumnIfMissing("wards", "pre_code", "TEXT");
    addColumnIfMissing("users", "block_id", "INTEGER REFERENCES blocks(id) ON DELETE SET NULL");
    addColumnIfMissing("pre_rounds", "block_id", "INTEGER REFERENCES blocks(id)");
    // Create indexes on ward columns — done here (after columns exist) not in schema.sql
    db.exec("CREATE INDEX IF NOT EXISTS idx_wards_block ON wards(block_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wards_pre   ON wards(pre_code)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wards_floor ON wards(floor_id)");
    // ── Step 3: one-time migration from floors / pre_assignments → blocks ──────
    runV2Migration();
}
function addColumnIfMissing(table, column, definition) {
    const cols = db.prepare(`PRAGMA table_info(${table})`)
        .all();
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
        const floors = db.prepare("SELECT id, name FROM floors").all();
        const insBlock = db.prepare(`INSERT OR IGNORE INTO blocks (name, name_key, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`);
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

/**
 * One-time migration script: copies all data from the existing SQLite database
 * into PostgreSQL. Run AFTER `npx prisma migrate deploy` has created the schema.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... SQLITE_PATH=/path/to/bedflow.db tsx scripts/sqlite-to-pg.ts
 *
 * Tables are migrated in FK-safe order (parents first).
 */

import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sqlitePath =
  process.env.SQLITE_PATH ||
  path.resolve(__dirname, "..", "database", "bedflow.db");

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found at: ${sqlitePath}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const sqlite = new DatabaseSync(sqlitePath);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

/** Migrate a single table: read all rows from SQLite, insert into Postgres. */
async function migrateTable(
  client: pg.PoolClient,
  table: string,
  columns: string[],
): Promise<number> {
  const rows = sqlite.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all() as Record<string, unknown>[];
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows (skipped)`);
    return 0;
  }

  const placeholders = rows.map(
    (_, ri) => `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(", ")})`
  ).join(", ");

  const values = rows.flatMap(row => columns.map(col => row[col] ?? null));

  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
    values
  );
  console.log(`  ${table}: ${rows.length} rows`);
  return rows.length;
}

async function resetSequences(client: pg.PoolClient, tables: string[]) {
  for (const table of tables) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1)) FROM ${table}`
    );
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("Migrating data from SQLite → PostgreSQL...\n");

    // Disable FK checks during bulk load
    await client.query("SET session_replication_role = replica");

    await migrateTable(client, "floors", ["id", "name"]);
    await migrateTable(client, "blocks", ["id", "name", "name_key", "label", "sort_order", "created_at", "updated_at"]);
    await migrateTable(client, "users", ["id", "username", "password_hash", "role", "name", "shift", "created_at", "updated_at", "block_id"]);
    await migrateTable(client, "wards", ["id", "name", "total_beds", "created_at", "updated_at", "block_id", "floor_id", "pre_code"]);
    await migrateTable(client, "beds", ["ward_id", "total", "vacant", "reserved", "occupied", "updated_at", "updated_by"]);
    await migrateTable(client, "pre_assignments", ["id", "user_id", "pre_code", "created_at"]);
    await migrateTable(client, "bed_status_updates", ["id", "ward_id", "vacant", "reserved", "occupied", "updated_by", "created_at"]);
    await migrateTable(client, "pre_rounds", ["id", "pre_code", "user_id", "shift", "round_key", "start_min", "submitted_at", "snapshot", "block_id"]);
    await migrateTable(client, "reminders", ["id", "target_role", "interval_min", "window_start", "window_end", "active"]);
    await migrateTable(client, "shifts", ["id", "key", "label", "start_time", "end_time"]);
    await migrateTable(client, "audit_logs", ["id", "ts", "user_id", "action", "entity", "detail"]);
    await migrateTable(client, "occupancy_snapshots", ["id", "ts", "total", "vacant", "reserved", "occupied"]);
    await migrateTable(client, "push_subscriptions", ["id", "user_id", "endpoint", "sub_json", "created_at"]);
    await migrateTable(client, "bed_details", ["id", "ward_id", "bed_number", "status", "updated_at", "updated_by"]);
    await migrateTable(client, "bed_movements", ["id", "bed_id", "old_status", "new_status", "changed_by", "changed_at"]);
    await migrateTable(client, "saved_views", ["id", "name", "created_by", "selected_wards", "is_shared", "is_system", "created_at", "updated_at"]);

    // Re-enable FK checks
    await client.query("SET session_replication_role = DEFAULT");

    // Reset all SERIAL sequences so new inserts get correct IDs
    await resetSequences(client, [
      "floors", "blocks", "users", "wards",
      "pre_assignments", "bed_status_updates", "pre_rounds",
      "reminders", "shifts", "audit_logs", "occupancy_snapshots",
      "push_subscriptions", "bed_details", "bed_movements", "saved_views",
    ]);

    await client.query("COMMIT");
    console.log("\nMigration complete.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\nMigration FAILED — rolled back:", e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main();

/**
 * migrate_to_new_db.js
 *
 * Step 1: Apply Prisma migrations to the target (Mumbai) DB.
 * Step 2: Copy structural data (users, blocks, wards, beds, assignments)
 *         from production (Singapore) — production is READ-ONLY.
 *
 * Run:
 *   node scripts/migrate_to_new_db.js
 *
 * Before running, set TARGET_DATABASE_URL and TARGET_DIRECT_URL below
 * (or pass them as env vars).
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { parse } from "dotenv";
import pg from "pg";

const { Pool } = pg;

// ── Connection strings ──────────────────────────────────────────────────────

const prodEnv = parse(readFileSync(new URL("../.env.production", import.meta.url)));

const TARGET_DATABASE_URL =
  process.env.TARGET_DATABASE_URL ||
  "postgresql://postgres.jaeugcgppvcbxaklxhev:kimsbedtracker@007@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const TARGET_DIRECT_URL =
  process.env.TARGET_DIRECT_URL ||
  "postgresql://postgres.jaeugcgppvcbxaklxhev:kimsbedtracker@007@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

// Production — READ ONLY
const prodPool = new Pool({
  connectionString: prodEnv.DIRECT_URL || prodEnv.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Target — the new Mumbai DB
const targetPool = new Pool({
  connectionString: TARGET_DIRECT_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Tables to copy (structural/setup data only) ─────────────────────────────
// Order matters for FK dependencies.
const TABLES_TO_COPY = [
  // hierarchy & structure
  "building_blocks",
  "blocks",
  "floors",
  "pre_blocks",
  "nursing_stations",

  // users & assignments
  "users",
  "pre_assignments",
  "user_pre_blocks",
  "nurse_access_assignments",

  // wards & beds
  "wards",
  "beds",
  "bed_details",
  "pre_block_wards",

  // config / master data
  "payer_types",
  "destinations",
  "departments",
  "doctors_master",
  "doctor_departments",
  "discharge_phases",
  "discharge_lounges",
  "payer_tat_config",
  "reminders",
  "saved_views",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getTableNames(pool) {
  const res = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `);
  return new Set(res.rows.map((r) => r.tablename));
}

async function getColumnsInBoth(poolA, poolB, table) {
  const q = `SELECT column_name FROM information_schema.columns
              WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`;
  const [a, b] = await Promise.all([poolA.query(q, [table]), poolB.query(q, [table])]);
  const setB = new Set(b.rows.map((r) => r.column_name));
  return a.rows.map((r) => r.column_name).filter((c) => setB.has(c));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   PROD → NEW DB migration (prod is read-only)   ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Step 1: Apply Prisma migrations to target ───────────────────────────
  console.log("📦  Step 1: Applying Prisma migrations to target DB...\n");

  // prisma.config.ts reads DIRECT_URL from env — override it to point at
  // the target DB. Set NODE_ENV to something neutral so dotenv doesn't
  // load .env.development and overwrite our override.
  try {
    execSync(
      `npx prisma migrate deploy`,
      {
        cwd: decodeURIComponent(new URL("..", import.meta.url).pathname),
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "migration",
          DATABASE_URL: TARGET_DATABASE_URL,
          DIRECT_URL: TARGET_DIRECT_URL,
        },
      }
    );
    console.log("\n✅  Migrations applied.\n");
  } catch (err) {
    console.error("❌  Prisma migrate deploy failed:", err.message);
    await prodPool.end();
    await targetPool.end();
    process.exit(1);
  }

  // ── Step 2: Figure out which tables exist in both ───────────────────────
  console.log("🔍  Checking table lists...");
  const [prodTables, targetTables] = await Promise.all([
    getTableNames(prodPool),
    getTableNames(targetPool),
  ]);

  const tablesToCopy = TABLES_TO_COPY.filter(
    (t) => prodTables.has(t) && targetTables.has(t)
  );
  const skipped = TABLES_TO_COPY.filter(
    (t) => !prodTables.has(t) || !targetTables.has(t)
  );
  if (skipped.length) console.log(`    Skipped (not in both): ${skipped.join(", ")}`);
  console.log(`    Will copy: ${tablesToCopy.join(", ")}\n`);

  // ── Step 3: READ from production ────────────────────────────────────────
  console.log("📥  Reading structural data from production (read-only)...");
  const prodData = {};
  for (const table of tablesToCopy) {
    const cols = await getColumnsInBoth(prodPool, targetPool, table);
    const res = await prodPool.query(
      `SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM "${table}"`
    );
    prodData[table] = { cols, rows: res.rows };
    console.log(`    ${table}: ${res.rows.length} rows (${cols.length} cols)`);
  }
  console.log("\n✅  Production read complete. Zero writes to prod.\n");

  // ── Step 4: WRITE to target (single transaction) ───────────────────────
  const client = await targetPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET session_replication_role = replica");

    console.log("🗑️   Clearing target tables...");
    const toClear = tablesToCopy.filter((t) => targetTables.has(t));
    if (toClear.length) {
      await client.query(
        `TRUNCATE TABLE ${toClear.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`
      );
    }
    console.log(`    Cleared ${toClear.length} tables.\n`);

    console.log("📤  Inserting into target...");
    for (const table of tablesToCopy) {
      const { cols, rows } = prodData[table];
      if (rows.length === 0) {
        console.log(`    ${table}: 0 — skipped`);
        continue;
      }
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const vals = cols.map((_, i) => `$${i + 1}`).join(", ");
      for (const row of rows) {
        await client.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${vals})`,
          cols.map((c) => row[c])
        );
      }
      console.log(`    ${table}: ${rows.length} rows`);
    }

    await client.query("SET session_replication_role = DEFAULT");
    await client.query("COMMIT");
    console.log("\n✅  Data committed to target.\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌  Data transaction failed — rolled back.\n", err.message);
    client.release();
    await prodPool.end();
    await targetPool.end();
    process.exit(1);
  }

  // ── Step 5: Reset sequences ────────────────────────────────────────────
  console.log("🔢  Resetting sequences...");
  for (const table of tablesToCopy) {
    try {
      const seqRes = await client.query(
        `SELECT pg_get_serial_sequence('${table}', 'id')`
      );
      const seq = seqRes.rows[0]?.pg_get_serial_sequence;
      if (!seq) continue;
      await client.query(
        `SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${table}"), 1))`,
        [seq]
      );
      console.log(`    ${table} → sequence reset`);
    } catch {
      /* no serial id column — skip */
    }
  }
  console.log("    Done.\n");

  client.release();
  await prodPool.end();
  await targetPool.end();

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   ✅  Migration complete!                        ║");
  console.log("║   Target DB has schema + structural data.       ║");
  console.log("║   Production was never written to.              ║");
  console.log("╚══════════════════════════════════════════════════╝");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

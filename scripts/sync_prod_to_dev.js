/**
 * sync_prod_to_dev.js
 *
 * Copies all data from the production (Singapore) database to the
 * development (Sydney) database. Production is READ-ONLY — no writes ever.
 *
 * Run: node scripts/sync_prod_to_dev.js
 */

import { readFileSync } from "fs";
import { parse } from "dotenv";
import pg from "pg";

const { Pool } = pg;

const prodEnv = parse(readFileSync(new URL("../.env.production", import.meta.url)));
const devEnv  = parse(readFileSync(new URL("../.env.development", import.meta.url)));

const prodPool = new Pool({ connectionString: prodEnv.DATABASE_URL,                           ssl: { rejectUnauthorized: false } });
const devPool  = new Pool({ connectionString: devEnv.DIRECT_URL || devEnv.DATABASE_URL,       ssl: { rejectUnauthorized: false } });

const PREFERRED_ORDER = [
  "building_blocks", "blocks", "floors", "nursing_stations",
  "payer_types", "pre_blocks", "users",
  "wards", "beds", "bed_details", "pre_block_wards",
  "nurse_access_assignments", "bed_status_updates",
  "pre_rounds", "pre_assignments",
  "audit_logs", "midnight_census", "occupancy_snapshots",
  "push_subscriptions", "reminders", "saved_views",
];

const DEV_ONLY_TRUNCATE = ["ward_operational_log", "bed_operational_log"];

async function getTableNames(pool) {
  const res = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `);
  return new Set(res.rows.map(r => r.tablename));
}

async function getColumnsInBoth(poolA, poolB, table) {
  const q = `SELECT column_name FROM information_schema.columns
              WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`;
  const [a, b] = await Promise.all([poolA.query(q, [table]), poolB.query(q, [table])]);
  const setB = new Set(b.rows.map(r => r.column_name));
  return a.rows.map(r => r.column_name).filter(c => setB.has(c));
}

async function run() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   PROD → DEV sync (prod is read-only)   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  console.log("🔍  Checking table lists...");
  const [prodTables, devTables] = await Promise.all([
    getTableNames(prodPool),
    getTableNames(devPool),
  ]);
  console.log(`    Prod: ${[...prodTables].sort().join(", ")}`);
  const devOnly = [...devTables].filter(t => !prodTables.has(t)).join(", ");
  console.log(`    Dev-only (stays empty): ${devOnly}\n`);

  const tablesToCopy = PREFERRED_ORDER.filter(t => prodTables.has(t) && devTables.has(t));

  // ── 1. READ from prod ────────────────────────────────────────────────────
  // Every table reads only columns present in BOTH prod and dev — schemas drift
  // (dev gets new columns first, or — as with the shift/night-shift removal —
  // dev drops columns prod still has) and a plain SELECT * would either insert
  // into nonexistent dev columns or omit new dev-only ones from being cleared.
  console.log("📥  Reading data from production...");
  const prodData = {};
  for (const table of tablesToCopy) {
    const cols = await getColumnsInBoth(prodPool, devPool, table);
    const res  = await prodPool.query(`SELECT ${cols.map(c => `"${c}"`).join(",")} FROM "${table}"`);
    prodData[table] = { cols, rows: res.rows };
    console.log(`    ${table}: ${res.rows.length} rows (${cols.length} shared cols)`);
  }
  if (prodTables.has("bed_movements") && devTables.has("bed_movements")) {
    const cols = await getColumnsInBoth(prodPool, devPool, "bed_movements");
    const res  = await prodPool.query(`SELECT ${cols.map(c=>`"${c}"`).join(",")} FROM "bed_movements"`);
    prodData["__bm"] = { cols, rows: res.rows };
    console.log(`    bed_movements: ${res.rows.length} rows (${cols.length} shared cols)`);
  }
  console.log("\n✅  Production read complete. Zero writes to prod.\n");

  // ── 2. WRITE to dev (single transaction) ────────────────────────────────
  const devClient = await devPool.connect();
  try {
    await devClient.query("BEGIN");
    await devClient.query("SET session_replication_role = replica");

    // Truncate
    console.log("🗑️   Truncating dev tables...");
    const toClear = [
      ...tablesToCopy,
      "bed_movements",
      ...DEV_ONLY_TRUNCATE.filter(t => devTables.has(t)),
    ];
    const unique = [...new Set(toClear)].filter(t => devTables.has(t));
    await devClient.query(
      `TRUNCATE TABLE ${unique.map(t => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
    console.log(`    Cleared ${unique.length} tables.\n`);

    // Insert regular tables
    console.log("📤  Inserting into dev...");
    for (const table of tablesToCopy) {
      const { cols, rows } = prodData[table];
      if (rows.length === 0) { console.log(`    ${table}: 0 — skipped`); continue; }
      const colList = cols.map(c => `"${c}"`).join(", ");
      const vals    = cols.map((_, i) => `$${i + 1}`).join(", ");
      for (const row of rows)
        await devClient.query(`INSERT INTO "${table}" (${colList}) VALUES (${vals})`, cols.map(c => row[c]));
      console.log(`    ${table}: ${rows.length} rows`);
    }

    // Insert bed_movements
    if (prodData["__bm"]) {
      const { cols, rows } = prodData["__bm"];
      const colList = cols.map(c => `"${c}"`).join(", ");
      const vals    = cols.map((_, i) => `$${i + 1}`).join(", ");
      for (const row of rows)
        await devClient.query(`INSERT INTO "bed_movements" (${colList}) VALUES (${vals})`, cols.map(c => row[c]));
      console.log(`    bed_movements: ${rows.length} rows`);
    }

    await devClient.query("SET session_replication_role = DEFAULT");
    await devClient.query("COMMIT");
    console.log("\n✅  Data committed.\n");

  } catch (err) {
    // ROLLBACK — ignore if tx is already aborted
    await devClient.query("ROLLBACK").catch(() => {});
    console.error("❌  Data transaction failed — rolled back.\n", err.message);
    devClient.release();
    await prodPool.end();
    await devPool.end();
    process.exit(1);
  }

  // ── 3. Reset sequences (OUTSIDE the data transaction) ───────────────────
  // Each setval runs in its own implicit transaction; a missing sequence just skips.
  console.log("🔢  Resetting sequences...");
  const seqTables = [...tablesToCopy, "bed_movements"];
  for (const table of seqTables) {
    try {
      const seqRes = await devClient.query(`SELECT pg_get_serial_sequence('${table}', 'id')`);
      const seq = seqRes.rows[0]?.pg_get_serial_sequence;
      if (!seq) continue;
      await devClient.query(
        `SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${table}"), 1))`,
        [seq]
      );
      console.log(`    ${table} → sequence reset`);
    } catch { /* no serial id column — skip */ }
  }
  console.log("    Done.\n");

  devClient.release();
  await prodPool.end();
  await devPool.end();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   ✅  Sync complete!                     ║");
  console.log("║   Dev DB now mirrors production data.   ║");
  console.log("║   Production was never written to.      ║");
  console.log("╚══════════════════════════════════════════╝");
}

run().catch(err => { console.error(err); process.exit(1); });

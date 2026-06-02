import bcrypt from "bcryptjs";
import { db } from "./index.js";
import { migrate } from "./migrate.js";
import { SHIFTS, PRE_INTERVAL_MIN } from "../config/domain.js";

// ── Hospital data (Image #11) ─────────────────────────────────────────────────
// Columns 1-5 in image are floor numbers; total = Grand Total column.
// Bed numbers start from (first digit of block name × 100) + 1 per ward.
const BLOCK_DATA: {
  name: string; label: string; sortOrder: number;
  wards: { name: string; total: number }[];
}[] = [
  {
    name: "1A", label: "Block 1A", sortOrder: 1,
    wards: [
      { name: "ER",             total: 12 },
      { name: "Leukemia/ICU",   total:  3 },
      { name: "Single/Sharing", total: 10 },
    ],
  },
  {
    name: "1B", label: "Block 1B", sortOrder: 2,
    wards: [
      { name: "Chemo DC",  total: 10 },
      { name: "DAYCARE",   total:  5 },
      { name: "Single",    total:  3 },
      { name: "TWIN",      total: 12 },
    ],
  },
  {
    name: "2A", label: "Block 2A", sortOrder: 3,
    wards: [
      { name: "Deluxe",    total: 10 },
      { name: "DIALYSIS",  total: 10 },
      { name: "Single",    total:  3 },
      { name: "TWIN",      total: 12 },
    ],
  },
  {
    name: "2B", label: "Block 2B", sortOrder: 4,
    wards: [
      { name: "Economy G/W",   total: 21 },
      { name: "Executive G/W", total:  5 },
      { name: "NICU",          total: 16 },
      { name: "PICU",          total:  5 },
    ],
  },
  {
    name: "2C", label: "Block 2C", sortOrder: 5,
    wards: [
      { name: "Chemo DC",     total: 12 },
      { name: "Leukemia/ICU", total:  9 },
    ],
  },
  {
    name: "3A", label: "Block 3A", sortOrder: 6,
    wards: [
      { name: "ICU",          total: 16 },
      { name: "Pre & Post OP", total: 11 },
    ],
  },
  {
    name: "3B", label: "Block 3B", sortOrder: 7,
    wards: [
      { name: "Deluxe",     total: 12 },
      { name: "Backup G/W", total: 10 },
    ],
  },
  {
    name: "4A", label: "Block 4A", sortOrder: 8,
    wards: [
      { name: "CTICU",      total:  7 },
      { name: "POST ANGIO", total: 11 },
    ],
  },
];

// PRE-N accounts — one per block in image order
const PRE_ACCOUNTS = [
  { username: "pre1", name: "PRE-1", block: "1A" },
  { username: "pre2", name: "PRE-2", block: "1B" },
  { username: "pre3", name: "PRE-3", block: "2A" },
  { username: "pre4", name: "PRE-4", block: "2B" },
  { username: "pre5", name: "PRE-5", block: "2C" },
  { username: "pre6", name: "PRE-6", block: "3A" },
  { username: "pre7", name: "PRE-7", block: "3B" },
  { username: "pre8", name: "PRE-8", block: "4A" },
];

/** Bed numbers start from the block's first digit × 100 + 1.
 *  e.g. "1A" → 101, "2B" → 201, "4A" → 401 */
function bedBase(blockName: string): number {
  return (parseInt(blockName[0], 10) || 1) * 100 + 1;
}

function wipe() {
  // Delete in FK-safe order (children before parents)
  const tables = [
    "bed_movements", "bed_details", "bed_status_updates",
    "push_subscriptions", "audit_logs", "occupancy_snapshots",
    "pre_rounds", "beds", "pre_assignments",
    "wards", "users", "blocks", "floors",
    "reminders", "shifts",
  ];
  db.exec("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    for (const t of tables) db.exec(`DELETE FROM ${t}`);
  });
  db.exec("PRAGMA foreign_keys = ON");
  console.log("Database wiped.");
}

function run() {
  migrate();
  wipe();

  const now = Date.now();

  db.transaction(() => {
    // ── 1. Blocks ────────────────────────────────────────────────────────────
    const insBlock = db.prepare(
      `INSERT INTO blocks (name, name_key, label, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`
    );
    for (const b of BLOCK_DATA)
      insBlock.run(b.name, b.name.toUpperCase(), b.label, b.sortOrder, now, now);

    const blockIdFor: Record<string, number> = {};
    for (const row of db.prepare("SELECT id, name_key FROM blocks").all<{ id: number; name_key: string }>())
      blockIdFor[row.name_key] = row.id;

    // ── 2. Wards + summary beds row + individual bed_details ─────────────────
    const insWard = db.prepare(
      `INSERT INTO wards (name, block_id, total_beds, created_at, updated_at)
       VALUES (?,?,?,?,?)`
    );
    const insBedSummary = db.prepare(
      `INSERT INTO beds (ward_id, total, vacant, reserved, occupied, updated_at)
       VALUES (?,?,NULL,NULL,NULL,NULL)`
    );
    const insBedDetail = db.prepare(
      `INSERT INTO bed_details (ward_id, bed_number, status, updated_at, updated_by)
       VALUES (?,?,?,?,NULL)`
    );

    let wardCount = 0, bedTotal = 0;
    for (const b of BLOCK_DATA) {
      const blockId = blockIdFor[b.name.toUpperCase()];
      if (!blockId) continue;
      const start = bedBase(b.name);

      for (const w of b.wards) {
        insWard.run(w.name, blockId, w.total, now, now);
        const ward = db.prepare("SELECT id FROM wards WHERE block_id=? AND name=?")
          .get<{ id: number }>(blockId, w.name);
        if (!ward) continue;

        insBedSummary.run(ward.id, w.total);

        // Generate individual beds: start..start+total-1 (per-ward, not global)
        for (let i = 0; i < w.total; i++)
          insBedDetail.run(ward.id, String(start + i), "VACANT", now);

        wardCount++;
        bedTotal += w.total;
      }
    }

    // ── 3. Users ─────────────────────────────────────────────────────────────
    const insUser = db.prepare(
      `INSERT INTO users
         (username, password_hash, role, name, shift, block_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    );

    for (const a of PRE_ACCOUNTS) {
      const blockId = blockIdFor[a.block.toUpperCase()] ?? null;
      insUser.run(
        a.username,
        bcrypt.hashSync(`${a.username}123`, 10),
        "PRE", a.name, "morning", blockId, now, now,
      );
    }

    insUser.run("manager", bcrypt.hashSync("manager123", 10), "MANAGER", "Ward Manager",          "morning", null, now, now);
    insUser.run("coo",     bcrypt.hashSync("coo123",     10), "COO",     "Chief Operating Officer", "morning", null, now, now);

    // ── 4. Shifts + reminders ─────────────────────────────────────────────────
    const insShift = db.prepare(
      "INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)"
    );
    for (const [key, s] of Object.entries(SHIFTS))
      insShift.run(key, s.label, s.start, s.end);

    const insRem = db.prepare(
      "INSERT INTO reminders (target_role, interval_min, window_start, window_end, active) VALUES (?,?,?,?,1)"
    );
    insRem.run("PRE", PRE_INTERVAL_MIN, "09:00", "18:30");
    insRem.run("COO", 180, "09:00", "18:00");

    console.log(`Seeded: ${BLOCK_DATA.length} blocks, ${wardCount} wards, ${bedTotal} total beds.`);
    console.log("");
    console.log("Logins:");
    for (const a of PRE_ACCOUNTS)
      console.log(`  ${a.username.padEnd(6)} (${a.name}, Block ${a.block})  →  ${a.username}123`);
    console.log("  manager  →  manager123");
    console.log("  coo      →  coo123");
  });
}

run();

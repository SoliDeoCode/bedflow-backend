import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "./index.js";
import { SHIFTS, PRE_INTERVAL_MIN } from "../config/domain.js";
// ── Hospital data (Image #11) ─────────────────────────────────────────────────
// Columns 1-5 in image are floor numbers; total = Grand Total column.
// Bed numbers start from (first digit of block name × 100) + 1 per ward.
const BLOCK_DATA = [
    {
        name: "1A", label: "Block 1A", sortOrder: 1,
        wards: [
            { name: "ER", total: 12 },
            { name: "Leukemia/ICU", total: 3 },
            { name: "Single/Sharing", total: 10 },
        ],
    },
    {
        name: "1B", label: "Block 1B", sortOrder: 2,
        wards: [
            { name: "Chemo DC", total: 10 },
            { name: "DAYCARE", total: 5 },
            { name: "Single", total: 3 },
            { name: "TWIN", total: 12 },
        ],
    },
    {
        name: "2A", label: "Block 2A", sortOrder: 3,
        wards: [
            { name: "Deluxe", total: 10 },
            { name: "DIALYSIS", total: 10 },
            { name: "Single", total: 3 },
            { name: "TWIN", total: 12 },
        ],
    },
    {
        name: "2B", label: "Block 2B", sortOrder: 4,
        wards: [
            { name: "Economy G/W", total: 21 },
            { name: "Executive G/W", total: 5 },
            { name: "NICU", total: 16 },
            { name: "PICU", total: 5 },
        ],
    },
    {
        name: "2C", label: "Block 2C", sortOrder: 5,
        wards: [
            { name: "Chemo DC", total: 12 },
            { name: "Leukemia/ICU", total: 9 },
        ],
    },
    {
        name: "3A", label: "Block 3A", sortOrder: 6,
        wards: [
            { name: "ICU", total: 16 },
            { name: "Pre & Post OP", total: 11 },
        ],
    },
    {
        name: "3B", label: "Block 3B", sortOrder: 7,
        wards: [
            { name: "Deluxe", total: 12 },
            { name: "Backup G/W", total: 10 },
        ],
    },
    {
        name: "4A", label: "Block 4A", sortOrder: 8,
        wards: [
            { name: "CTICU", total: 7 },
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
function bedBase(blockName) {
    return (parseInt(blockName[0], 10) || 1) * 100 + 1;
}
async function wipe() {
    // TRUNCATE ... CASCADE is PostgreSQL — drops all rows and resets sequences in FK-safe order
    await db.exec(`
    TRUNCATE TABLE
      bed_movements, bed_details, bed_status_updates,
      push_subscriptions, audit_logs, occupancy_snapshots,
      pre_rounds, beds, pre_assignments,
      saved_views, wards, users, blocks, floors,
      reminders, shifts
    RESTART IDENTITY CASCADE
  `);
    console.log("Database wiped.");
}
async function run() {
    await wipe();
    const now = Date.now();
    await db.transaction(async () => {
        // ── 1. Blocks ────────────────────────────────────────────────────────────
        for (const b of BLOCK_DATA) {
            await db.prepare(`INSERT INTO blocks (name, name_key, label, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`).run(b.name, b.name.toUpperCase(), b.label, b.sortOrder, now, now);
        }
        const blockRows = await db.prepare("SELECT id, name_key FROM blocks").all();
        const blockIdFor = {};
        for (const row of blockRows)
            blockIdFor[row.name_key] = row.id;
        // ── 2. Wards + summary beds row + individual bed_details ─────────────────
        let wardCount = 0, bedTotal = 0;
        for (const b of BLOCK_DATA) {
            const blockId = blockIdFor[b.name.toUpperCase()];
            if (!blockId)
                continue;
            const start = bedBase(b.name);
            for (const w of b.wards) {
                await db.prepare(`INSERT INTO wards (name, block_id, total_beds, created_at, updated_at)
           VALUES (?,?,?,?,?)`).run(w.name, blockId, w.total, now, now);
                const ward = await db.prepare("SELECT id FROM wards WHERE block_id=? AND name=?")
                    .get(blockId, w.name);
                if (!ward)
                    continue;
                await db.prepare(`INSERT INTO beds (ward_id, total, vacant, reserved, occupied, updated_at)
           VALUES (?,?,NULL,NULL,NULL,NULL)`).run(ward.id, w.total);
                // Generate individual beds: start..start+total-1 (per-ward, not global)
                const insBedDetail = db.prepare(`INSERT INTO bed_details (ward_id, bed_number, physical_status, reservation_status, updated_at, updated_by)
           VALUES (?,?,'VACANT','NONE',?,NULL) ON CONFLICT (ward_id, bed_number) DO NOTHING`);
                for (let i = 0; i < w.total; i++) {
                    await insBedDetail.run(ward.id, String(start + i), now);
                }
                wardCount++;
                bedTotal += w.total;
            }
        }
        // ── 3. Users ─────────────────────────────────────────────────────────────
        for (const a of PRE_ACCOUNTS) {
            const blockId = blockIdFor[a.block.toUpperCase()] ?? null;
            await db.prepare(`INSERT INTO users
           (username, password_hash, role, name, shift, block_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`).run(a.username, bcrypt.hashSync(`${a.username}123`, 10), "PRE", a.name, "morning", blockId, now, now);
        }
        await db.prepare(`INSERT INTO users (username, password_hash, role, name, shift, block_id, created_at, updated_at)
       VALUES (?,?,?,?,?,NULL,?,?)`).run("manager", bcrypt.hashSync("manager123", 10), "MANAGER", "Ward Manager", "morning", now, now);
        await db.prepare(`INSERT INTO users (username, password_hash, role, name, shift, block_id, created_at, updated_at)
       VALUES (?,?,?,?,?,NULL,?,?)`).run("admin1", bcrypt.hashSync("admin123", 10), "COO", "Administrator", "morning", now, now);
        // ── 4. Shifts + reminders ─────────────────────────────────────────────────
        for (const [key, s] of Object.entries(SHIFTS)) {
            await db.prepare("INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)").run(key, s.label, s.start, s.end);
        }
        await db.prepare("INSERT INTO reminders (target_role, interval_min, window_start, window_end, active) VALUES (?,?,?,?,1)").run("PRE", PRE_INTERVAL_MIN, "09:00", "18:30");
        await db.prepare("INSERT INTO reminders (target_role, interval_min, window_start, window_end, active) VALUES (?,?,?,?,1)").run("COO", 180, "09:00", "18:00");
        // ── 5. System saved views ─────────────────────────────────────────────────
        const SYSTEM_VIEWS = [
            { name: "All Beds", wards: [] },
            { name: "Critical Care", wards: ["ICU", "CTICU", "NICU", "PICU", "Leukemia/ICU"] },
            { name: "Pediatrics", wards: ["PICU", "NICU", "DAYCARE"] },
            { name: "Emergency", wards: ["ER", "Pre & Post OP"] },
            { name: "Dialysis", wards: ["DIALYSIS"] },
        ];
        for (const v of SYSTEM_VIEWS) {
            await db.prepare(`INSERT INTO saved_views (name, created_by, selected_wards, is_shared, is_system, created_at, updated_at)
         VALUES (?, NULL, ?, 1, 1, ?, ?) ON CONFLICT DO NOTHING`).run(v.name, JSON.stringify(v.wards), now, now);
        }
        console.log(`Seeded: ${BLOCK_DATA.length} blocks, ${wardCount} wards, ${bedTotal} total beds.`);
        console.log("");
        console.log("Logins:");
        for (const a of PRE_ACCOUNTS)
            console.log(`  ${a.username.padEnd(6)} (${a.name}, Block ${a.block})  →  ${a.username}123`);
        console.log("  manager  →  manager123");
        console.log("  coo      →  coo123");
    });
}
run().catch(err => { console.error("Seed failed:", err); process.exit(1); });

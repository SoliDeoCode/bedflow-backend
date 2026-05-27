import bcrypt from "bcryptjs";
import { db } from "./index.js";
import { migrate } from "./migrate.js";
import { SHIFTS, PRE_INTERVAL_MIN } from "../config/domain.js";
// ── Block → ward data (from hospital floor plan, image 2026-05-27) ──────────
const BLOCK_DATA = [
    { name: "1A", label: "Block 1A",
        wards: [["ER", 12], ["Leukemia/ICU", 3], ["Single/Sharing", 10]] },
    { name: "1B", label: "Block 1B",
        wards: [["Chemo DC", 10], ["DAYCARE (GASTRO)", 5], ["Single", 3], ["TWIN", 12]] },
    { name: "2A", label: "Block 2A",
        wards: [["Deluxe", 10], ["DIALYSIS", 10], ["Single", 3], ["TWIN", 12]] },
    { name: "2B", label: "Block 2B",
        wards: [["Economy G/W", 21], ["Executive G/W", 5], ["NICU", 16], ["PICU", 5]] },
    { name: "2C", label: "Block 2C",
        wards: [["Chemo DC", 12], ["Leukemia/ICU", 9]] },
    { name: "3A", label: "Block 3A",
        wards: [["ICU", 16], ["Pre & Post OP", 11]] },
    { name: "3B", label: "Block 3B",
        wards: [["Deluxe", 12], ["Backup G/W", 10]] },
    { name: "4A", label: "Block 4A",
        wards: [["CT ICU", 7], ["POST ANGIO", 11]] },
];
const PRE_ACCOUNTS = [
    { username: "pre1", block: "1A" },
    { username: "pre2", block: "1B" },
    { username: "pre3", block: "2A" },
    { username: "pre4", block: "2B" },
    { username: "pre5", block: "2C" },
    { username: "pre6", block: "3A" },
    { username: "pre7", block: "3B" },
    { username: "pre8", block: "4A" },
];
function run() {
    migrate();
    const now = Date.now();
    db.transaction(() => {
        // ── 1. Blocks ────────────────────────────────────────────────────────────
        const insBlock = db.prepare(`INSERT OR IGNORE INTO blocks (name, name_key, label, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`);
        BLOCK_DATA.forEach((b, i) => insBlock.run(b.name, b.name.toUpperCase(), b.label, i + 1, now, now));
        const blockIdFor = {};
        for (const b of db.prepare("SELECT id, name_key FROM blocks").all())
            blockIdFor[b.name_key] = b.id;
        // ── 2. Wards + bed rows ───────────────────────────────────────────────────
        const insWard = db.prepare(`INSERT OR IGNORE INTO wards (name, block_id, total_beds, created_at, updated_at)
       VALUES (?,?,?,?,?)`);
        const insBed = db.prepare(`INSERT OR IGNORE INTO beds (ward_id, total, vacant, reserved, occupied, updated_at)
       VALUES (?,?,NULL,NULL,NULL,NULL)`);
        let wardCount = 0, bedTotal = 0;
        for (const b of BLOCK_DATA) {
            const bid = blockIdFor[b.name.toUpperCase()];
            if (!bid)
                continue;
            for (const [wardName, total] of b.wards) {
                insWard.run(wardName, bid, total, now, now);
                const w = db.prepare("SELECT id FROM wards WHERE block_id=? AND name=?")
                    .get(bid, wardName);
                if (w) {
                    insBed.run(w.id, total);
                    wardCount++;
                    bedTotal += total;
                }
            }
        }
        // ── 3. Users ─────────────────────────────────────────────────────────────
        const insUser = db.prepare(`INSERT OR IGNORE INTO users
         (username, password_hash, role, name, shift, block_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`);
        // PRE accounts — one per block
        for (const a of PRE_ACCOUNTS) {
            const bid = blockIdFor[a.block.toUpperCase()] ?? null;
            const displayName = `${a.block} Manager`;
            insUser.run(a.username, bcrypt.hashSync(`${a.username}123`, 10), "PRE", displayName, "morning", bid, now, now);
        }
        // MANAGER + COO
        insUser.run("manager", bcrypt.hashSync("manager123", 10), "MANAGER", "Ward Manager", "morning", null, now, now);
        insUser.run("coo", bcrypt.hashSync("coo123", 10), "COO", "Chief Operating Officer", "morning", null, now, now);
        // ── 4. Shifts + reminders ─────────────────────────────────────────────────
        const insShift = db.prepare("INSERT OR IGNORE INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)");
        for (const [key, s] of Object.entries(SHIFTS))
            insShift.run(key, s.label, s.start, s.end);
        const insRem = db.prepare("INSERT OR IGNORE INTO reminders (target_role,interval_min,window_start,window_end,active) VALUES (?,?,?,?,1)");
        insRem.run("PRE", PRE_INTERVAL_MIN, "09:00", "18:30");
        insRem.run("COO", 180, "09:00", "18:00");
        console.log(`Seeded: ${BLOCK_DATA.length} blocks, ${wardCount} wards, ${bedTotal} total beds.`);
        console.log("Logins: pre1..pre8 → preN123 | manager → manager123 | coo → coo123");
    });
}
run();

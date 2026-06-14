import "dotenv/config";
import { db } from "./index.js";
// ── Data parsed from BED MATRIX (1).xlsx ──────────────────────────────────────
const WARD_DATA = [
    // ── Block A ─────────────────────────────────────────────────────────────────
    { block: "A", floor: "GF", name: "Emergency", bedType: "Non Census", operational: true, unitType: "KIMS", roomType: "Emergency", beds: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] },
    { block: "A", floor: "1F", name: "Day Care - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "Renova - Day Care", beds: ["CDC 1", "CDC 2", "CDC 3", "CDC 4", "CDC 5", "CDC 6", "CDC 7", "CDC 8", "CDC 9", "CDC 10"] },
    { block: "A", floor: "1F", name: "Day Care - Gastro", bedType: "Census", operational: true, unitType: "KIMS", roomType: "Day Care", beds: ["CDC 11", "CDC 12", "CDC 13", "CDC 14", "CDC 15"] },
    { block: "A", floor: "2F", name: "Economy MGW", bedType: "Census", operational: true, unitType: "KIMS", roomType: "MGW NON AC", beds: ["GM 1", "GM 2", "GM 3", "GM 4", "GM 5", "GM 6", "GM 7", "GM 8", "GM 9", "GM 10", "GM 11", "GM 12", "GM 13"] },
    { block: "A", floor: "2F", name: "Economy FGW", bedType: "Census", operational: true, unitType: "KIMS", roomType: "FGW NON AC", beds: ["GF 1", "GF 2", "GF 3", "GF 4", "GF 5", "GF 6", "GF 7", "GF 8"] },
    { block: "A", floor: "2F", name: "PICU - GW", bedType: "Census", operational: true, unitType: "KIMS", roomType: "GW (AC)", beds: ["PICU 1", "PICU 2", "PICU 3", "PICU 4", "PICU 5"] },
    { block: "A", floor: "2F", name: "PICU - Peads", bedType: "Census", operational: true, unitType: "KIMS", roomType: "PICU", beds: ["PICU 7", "PICU 8", "PICU 9", "PICU 10", "PICU 11"] },
    { block: "A", floor: "2F", name: "NICU", bedType: "Census", operational: true, unitType: "KIMS", roomType: "NICU", beds: ["NICU 1", "NICU 2", "NICU 3", "NICU 4", "NICU 5", "NICU 6", "NICU 7", "NICU 8", "NICU 9", "NICU 10", "NICU 11", "NICU 12", "NICU 13", "NICU 14", "NICU 15", "NICU 16"] },
    { block: "A", floor: "2F", name: "Maternity ICU - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "Renova - ICU", beds: ["CHEMO 1", "CHEMO 2", "CHEMO 3", "CHEMO 4"] },
    { block: "A", floor: "2F", name: "HDU - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "Renova - Day Care", beds: ["Z3 CHEMO 1", "Z3 CHEMO 2", "Z3 CHEMO 3", "Z3 CHEMO 4"] },
    { block: "A", floor: "2F", name: "Dialysis - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "Renova - Day Care", beds: ["Z1 CHEMO 1", "Z1 CHEMO 2", "Z1 CHEMO 3", "Z1 CHEMO 4", "Z1 CHEMO 5", "Z1 CHEMO 6", "Z1 CHEMO 7", "Z1 CHEMO 8"] },
    { block: "A", floor: "2F", name: "Positive Dialysis - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "Renova - Day Care", beds: ["Z2 CHEMO 1", "Z2 CHEMO 2", "Z2 CHEMO 3", "Z2 CHEMO 4"] },
    { block: "A", floor: "2F", name: "Dialysis", bedType: "Non Census", operational: true, unitType: "KIMS", roomType: "Dialysis", beds: ["D 1", "D 2", "D 3", "D 4", "D 5", "D 6", "D 7", "D 8", "D 9", "D 10"] },
    { block: "A", floor: "3F", name: "Premium Block - Single Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "SINGLE ROOM - AC", beds: ["301", "302", "303", "304", "306", "307", "308", "309", "310", "311", "312"] },
    { block: "A", floor: "3F", name: "Premium Block - Suite Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "SINGLE ROOM - AC", beds: ["305"] },
    { block: "A", floor: "3F", name: "MICU I", bedType: "Census", operational: true, unitType: "KIMS", roomType: "ICU", beds: ["MICU I 1", "MICU I 2", "MICU I 3", "MICU I 4", "MICU I 5", "MICU I 6", "MICU I 7", "MICU I 8"] },
    { block: "A", floor: "3F", name: "MICU II", bedType: "Census", operational: true, unitType: "KIMS", roomType: "ICU", beds: ["MICU II 1", "MICU II 2", "MICU II 3", "MICU II 4", "MICU II 5", "MICU II 6", "MICU II 7", "MICU II 8"] },
    { block: "A", floor: "3F", name: "Post OP", bedType: "Census", operational: true, unitType: "KIMS", roomType: "OR - Obs", beds: ["POST 1", "POST 2", "POST 3", "POST 4", "POST 5"] },
    { block: "A", floor: "3F", name: "Pre OP", bedType: "Census", operational: true, unitType: "KIMS", roomType: "OR - Obs", beds: ["PRE 1", "PRE 2", "PRE 3", "PRE 4", "PRE 5", "PRE 6"] },
    { block: "A", floor: "4F", name: "MICU - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "ICU", beds: ["MICU III 1", "MICU III 2", "MICU III 3", "MICU III 4", "MICU III 5"] },
    { block: "A", floor: "4F", name: "SICU - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "ICU", beds: ["SICU 1", "SICU 2", "SICU 3", "SICU 4", "SICU 5"] },
    { block: "A", floor: "4F", name: "BMT - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "BMT", beds: ["BMT 1", "BMT 2", "BMT 3"] },
    { block: "A", floor: "4F", name: "Single Room - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "SINGLE ROOM - AC", beds: ["403", "404", "405", "406", "407", "409", "410"] },
    { block: "A", floor: "4F", name: "Twin Sharing - Renova", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "TWIN SHARING - AC", beds: ["401A", "401B", "402A", "402B", "408A", "408B"] },
    // ── Block B ─────────────────────────────────────────────────────────────────
    { block: "B", floor: "1F", name: "General Ward - I", bedType: "Census", operational: false, unitType: "KIMS", roomType: "General Ward", beds: ["ASRI 1", "ASRI 2", "ASRI 3", "ASRI 4", "ASRI 5", "ASRI 6", "ASRI 7", "ASRI 8", "ASRI 9", "ASRI 10"] },
    { block: "B", floor: "1F", name: "General Ward - II", bedType: "Census", operational: false, unitType: "KIMS", roomType: "General Ward", beds: ["ASRI 11", "ASRI 12", "ASRI 13", "ASRI 14", "ASRI 15", "ASRI 16", "ASRI 17", "ASRI 18", "ASRI 19", "ASRI 20"] },
    { block: "B", floor: "1F", name: "Economy Ward - Single Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "SINGLE ROOM", beds: ["108", "109", "110"] },
    { block: "B", floor: "1F", name: "Economy Ward - Twin Sharing Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "TWIN SHARING", beds: ["101A", "101B", "102A", "102B", "103A", "103B", "104A", "104B", "105A", "105B", "106A", "106B"] },
    { block: "B", floor: "1F", name: "LT / KT Ward - Sharing Rooms", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "TWIN SHARING - AC", beds: ["LTKT 117A", "LTKT 117B", "LTKT 118A", "LTKT 118B"] },
    { block: "B", floor: "1F", name: "LT / KT Ward - Single Rooms", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "SINGLE ROOM - AC", beds: ["LTKT 111", "LTKT 112", "LTKT 113", "LTKT 114", "LTKT 115", "LTKT 116"] },
    { block: "B", floor: "1F", name: "LT / KT Ward - ICU", bedType: "Census", operational: true, unitType: "KIMS - Renova", roomType: "LT KT ICU", beds: ["LTKT ICU 1", "LTKT ICU 2", "LTKT ICU 3"] },
    { block: "B", floor: "2F", name: "Executive - Single Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "SINGLE ROOM - AC", beds: ["210", "211", "212", "213", "214", "215", "216", "217", "218", "219", "220"] },
    { block: "B", floor: "2F", name: "Economy - Sharing Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "TWIN SHARING - AC", beds: ["201A", "201B", "202A", "202B", "203A", "203B", "204A", "204B", "205A", "205B", "206A", "206B"] },
    { block: "B", floor: "2F", name: "Economy - Single Room", bedType: "Census", operational: true, unitType: "KIMS", roomType: "SINGLE ROOM - NON AC", beds: ["207", "208", "209"] },
    { block: "B", floor: "4F", name: "Post Cath ICU", bedType: "Census", operational: true, unitType: "KIMS", roomType: "CICU", beds: ["ANGIO 1", "ANGIO 2", "ANGIO 3", "ANGIO 4", "ANGIO 5", "ANGIO 6", "ANGIO 7", "ANGIO 8", "ANGIO 9", "ANGIO 10", "ANGIO 11"] },
    { block: "B", floor: "4F", name: "CT ICU", bedType: "Census", operational: true, unitType: "KIMS", roomType: "CTICU", beds: ["CTICU 1", "CTICU 2", "CTICU 3", "CTICU 4", "CTICU 5", "CTICU 6", "CTICU 7"] },
];
async function run() {
    const now = Date.now();
    // ── 1. Building blocks (A, B) ───────────────────────────────────────────────
    for (const [i, name] of ["A", "B"].entries()) {
        await db.prepare(`INSERT INTO building_blocks (name, label, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?) ON CONFLICT (name) DO NOTHING`).run(name, `Block ${name}`, i + 1, now, now);
    }
    const bbRows = await db.prepare("SELECT id, name FROM building_blocks").all();
    const bbId = {};
    for (const b of bbRows)
        bbId[b.name] = b.id;
    // ── 2. Floors (per building block — unique on code+block_label) ────────────
    const floorOrder = ["GF", "1F", "2F", "3F", "4F"];
    const allFloors = [...new Set(WARD_DATA.map(w => `${w.block}|${w.floor}`))];
    for (const key of allFloors) {
        const [block, floor] = key.split("|");
        const sortOrder = floorOrder.indexOf(floor) + 1;
        await db.prepare(`INSERT INTO floors (name, block_label, code, sort_order, building_block_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT (code, block_label) DO NOTHING`).run(floor, block, `${block}-${floor}`, sortOrder, bbId[block], now, now);
    }
    const floorRows = await db.prepare("SELECT id, code FROM floors").all();
    const floorId = {};
    for (const f of floorRows)
        floorId[f.code] = f.id;
    // ── 3. Blocks (one per building block, for PRE assignment purposes) ─────────
    for (const [i, name] of ["A", "B"].entries()) {
        await db.prepare(`INSERT INTO blocks (name, name_key, label, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT (name_key) DO NOTHING`).run(name, name.toUpperCase(), `Block ${name}`, i + 1, now, now);
    }
    const blockRows = await db.prepare("SELECT id, name_key FROM blocks").all();
    const blockId = {};
    for (const b of blockRows)
        blockId[b.name_key] = b.id;
    // ── 4. Wards + beds summary + bed_details ───────────────────────────────────
    let wardCount = 0, bedTotal = 0;
    for (const w of WARD_DATA) {
        const bId = blockId[w.block.toUpperCase()];
        const fId = floorId[`${w.block}-${w.floor}`];
        if (!bId) {
            console.warn(`Block ${w.block} not found`);
            continue;
        }
        if (!fId) {
            console.warn(`Floor ${w.block}-${w.floor} not found`);
            continue;
        }
        await db.prepare(`INSERT INTO wards
         (name, block_id, floor_id, total_beds, bed_type, default_bed_type, unit_type, room_type, operational, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(w.name, bId, fId, w.beds.length, w.bedType, w.bedType, w.unitType, w.roomType, w.operational, now, now);
        const ward = await db.prepare("SELECT id FROM wards WHERE block_id=? AND name=?")
            .get(bId, w.name);
        if (!ward)
            continue;
        await db.prepare(`INSERT INTO beds (ward_id, total, vacant, reserved, occupied, occupied_reserved, updated_at)
       VALUES (?,?,NULL,NULL,NULL,0,NULL)`).run(ward.id, w.beds.length);
        const insBed = db.prepare(`INSERT INTO bed_details
         (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, updated_at)
       VALUES (?,?,'VACANT','NONE',?,?,?) ON CONFLICT (ward_id, bed_name) DO NOTHING`);
        for (const bedName of w.beds) {
            await insBed.run(ward.id, bedName, w.bedType, w.operational, now);
        }
        wardCount++;
        bedTotal += w.beds.length;
        console.log(`  Block ${w.block} ${w.floor.padEnd(3)} | ${w.name.padEnd(35)} ${w.beds.length} beds`);
    }
    // ── 5. Shifts ────────────────────────────────────────────────────────────────
    await db.prepare("INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run("morning", "Morning", "07:00", "14:00");
    await db.prepare("INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run("evening", "Evening", "14:00", "21:00");
    await db.prepare("INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run("night", "Night", "21:00", "07:00");
    console.log(`\nDone. ${wardCount} wards, ${bedTotal} beds inserted.`);
}
run().catch(err => { console.error("Seed failed:", err); process.exit(1); });

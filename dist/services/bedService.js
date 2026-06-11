import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { startOfDayIST } from "../config/domain.js";
export async function wardsForBlock(blockId) {
    return db.prepare(`SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.block_id = ? ORDER BY w.name`).all(blockId);
}
export function summarize(wards) {
    let v = 0, r = 0, o = 0, or_ = 0, total = 0, wardsDone = 0;
    for (const w of wards) {
        total += w.total;
        if (w.vacant !== null) {
            wardsDone++;
            v += w.vacant || 0;
            r += w.reserved || 0;
            o += w.occupied || 0;
            or_ += w.occupied_reserved || 0;
        }
    }
    return { v, r, o, or: or_, total, wards: wards.length, wardsDone,
        complete: wards.length > 0 && wardsDone === wards.length };
}
export async function updateWard(wardId, vacantNone, vacantReserved, occupiedNone, occupiedReserved, userId) {
    const ward = await db.prepare("SELECT id, name, total_beds AS total, block_id FROM wards WHERE id = ?").get(wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    const vn = Math.max(0, Math.floor(vacantNone));
    const vr = Math.max(0, Math.floor(vacantReserved));
    const on_ = Math.max(0, Math.floor(occupiedNone));
    const or_ = Math.max(0, Math.floor(occupiedReserved));
    if (vn + vr + on_ + or_ !== ward.total)
        throw new HttpError(400, `Counts must total ${ward.total} beds`);
    const now = Date.now();
    await db.transaction(async () => {
        await db.prepare("UPDATE beds SET vacant=?, reserved=?, occupied=?, occupied_reserved=?, updated_at=?, updated_by=? WHERE ward_id=?").run(vn, vr, on_, or_, now, userId, wardId);
        await db.prepare("INSERT INTO bed_status_updates (ward_id, vacant_none, vacant_reserved, occupied_none, occupied_reserved, updated_by, created_at) VALUES (?,?,?,?,?,?,?)").run(wardId, vn, vr, on_, or_, userId, now);
    });
    const blockName = (await db.prepare("SELECT name FROM blocks WHERE id = ?")
        .get(ward.block_id))?.name ?? String(ward.block_id);
    await audit(userId, "ward_update", blockName, {
        ward: ward.name, vacant_none: vn, vacant_reserved: vr,
        occupied_none: on_, occupied_reserved: or_,
    });
    return { ward: ward.name, vacant: vn, reserved: vr, occupied: on_, occupied_reserved: or_, total: ward.total };
}
export async function orgOverview() {
    const blocks = await db.prepare("SELECT id, name, label, sort_order FROM blocks ORDER BY sort_order, name").all();
    const today = startOfDayIST();
    const items = await Promise.all(blocks.map(async (block) => {
        const wards = await wardsForBlock(block.id);
        const last = await db.prepare("SELECT submitted_at FROM pre_rounds WHERE block_id=? ORDER BY submitted_at DESC LIMIT 1").get(block.id);
        const roundsRow = await db.prepare("SELECT COUNT(*) AS c FROM pre_rounds WHERE block_id=? AND submitted_at>=?").get(block.id, today);
        const assignedUser = await db.prepare("SELECT id, name, shift FROM users WHERE block_id=? AND role='PRE' LIMIT 1").get(block.id) ?? null;
        return {
            block_id: block.id, pre: block.name, floor: block.name,
            label: block.label || block.name, wards,
            summary: summarize(wards),
            lastSubmittedAt: last?.submitted_at ?? null,
            roundsToday: roundsRow?.c ?? 0,
            assignedUser,
        };
    }));
    const floors = items.map(item => ({ name: item.pre, pres: [item] }));
    let v = 0, r = 0, o = 0, or_ = 0, total = 0, presReporting = 0, presTotal = 0;
    for (const item of items) {
        v += item.summary.v;
        r += item.summary.r;
        o += item.summary.o;
        or_ += item.summary.or;
        total += item.summary.total;
        if (item.summary.wards > 0) {
            presTotal++;
            if (item.summary.wardsDone > 0)
                presReporting++;
        }
    }
    return { floors, totals: { v, r, o, or: or_, total, presReporting, presTotal } };
}
export async function snapshotOccupancy() {
    const { totals } = await orgOverview();
    // vacant = all physically vacant (v+r), reserved = all with reservation (r+or), occupied = all physically occupied (o+or)
    await db.prepare("INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied) VALUES (?,?,?,?,?)").run(Date.now(), totals.total, totals.v + totals.r, totals.r + totals.or, totals.o + totals.or);
}

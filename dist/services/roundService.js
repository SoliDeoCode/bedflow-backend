import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { wardsForPreBlock } from "./bedService.js";
import { inShift, currentRound, roundKey, todayStr, minsNow, formatShiftWindow, } from "../config/domain.js";
export async function userShift(userId) {
    const u = await db.prepare("SELECT shift FROM users WHERE id=?").get(userId);
    return u?.shift || "morning";
}
export async function setShift(userId, shift) {
    await db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, Date.now(), userId);
}
/** Alarm state for a PRE Block. */
export async function alarmState(preBlockId, shift) {
    const mins = minsNow();
    const onDuty = inShift(shift, mins);
    const round = currentRound(shift, mins);
    const wardCountRow = await db.prepare("SELECT COUNT(*) AS n FROM pre_block_wards WHERE pre_block_id=?").get(preBlockId);
    const hasWards = (wardCountRow?.n ?? 0) > 0;
    const key = roundKey(`pb${preBlockId}`, shift, todayStr(), round.startMin);
    const submitted = !!(await db.prepare("SELECT 1 FROM pre_rounds WHERE round_key=?").get(key));
    return { shift, onDuty, round, key, submitted, hasWards,
        alarmActive: onDuty && hasWards && !submitted,
        shiftWindow: formatShiftWindow(shift) };
}
/** Submit a round for the PRE Block the PRE user is assigned to. */
export async function submitRound(preBlockId, userId) {
    const wards = await wardsForPreBlock(preBlockId);
    if (wards.length === 0)
        throw new HttpError(400, "No wards assigned to this PRE Block");
    const wardIds = wards.map(w => w.id);
    const bedDetailRows = await db.prepare(`SELECT DISTINCT ward_id FROM bed_details WHERE ward_id = ANY(?)`).all(wardIds);
    const wardHasBeds = new Set(bedDetailRows.map(r => Number(r.ward_id)));
    for (const w of wards) {
        if (w.vacant === null)
            throw new HttpError(400, `Enter all wards first (${w.ward} missing)`);
        if (!wardHasBeds.has(w.id)) {
            const sum = w.vacant + (w.reserved || 0) + (w.occupied || 0);
            if (sum !== w.total)
                throw new HttpError(400, `${w.ward}: counts must total ${w.total}`);
        }
    }
    const shift = await userShift(userId);
    const round = currentRound(shift, minsNow());
    const key = roundKey(`pb${preBlockId}`, shift, todayStr(), round.startMin);
    try {
        await db.prepare(`INSERT INTO pre_rounds
         (pre_code, pre_block_id, user_id, shift, round_key, start_min, submitted_at, snapshot)
       VALUES (?,?,?,?,?,?,?,?)`).run(`pb${preBlockId}`, preBlockId, userId, shift, key, round.startMin, Date.now(), JSON.stringify(wards));
    }
    catch { /* duplicate round key — idempotent */ }
    await audit(userId, "round_submit", `pb${preBlockId}`, { roundKey: key });
    return { ok: true, roundKey: key };
}

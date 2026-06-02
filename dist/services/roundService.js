import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { wardsForBlock } from "./bedService.js";
import { inShift, currentRound, roundKey, todayStr, minsNow, } from "../config/domain.js";
export async function userShift(userId) {
    const u = await db.prepare("SELECT shift FROM users WHERE id=?").get(userId);
    return u?.shift || "morning";
}
export async function setShift(userId, shift) {
    await db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, Date.now(), userId);
}
/** Alarm state for a block (looked up by block name). */
export async function alarmState(blockName, shift) {
    const mins = minsNow();
    const onDuty = inShift(shift, mins);
    const round = currentRound(shift, mins);
    const block = await db.prepare("SELECT id FROM blocks WHERE name_key = ?")
        .get(blockName.toUpperCase().trim());
    const wardCountRow = block
        ? await db.prepare("SELECT COUNT(*) AS n FROM wards WHERE block_id=?")
            .get(block.id)
        : null;
    const hasWards = (wardCountRow?.n ?? 0) > 0;
    const key = roundKey(blockName, shift, todayStr(), round.startMin);
    const submitted = !!(await db.prepare("SELECT 1 FROM pre_rounds WHERE round_key=?").get(key));
    return { shift, onDuty, round, key, submitted, hasWards,
        alarmActive: onDuty && hasWards && !submitted };
}
/** Submit a round for the block the user is assigned to. */
export async function submitRound(blockId, userId) {
    const wards = await wardsForBlock(blockId);
    if (wards.length === 0)
        throw new HttpError(400, "No wards to submit");
    for (const w of wards) {
        if (w.vacant === null)
            throw new HttpError(400, `Enter all wards first (${w.ward} missing)`);
        const hasBedDetails = !!(await db.prepare("SELECT 1 FROM bed_details WHERE ward_id=? LIMIT 1").get(w.id));
        if (!hasBedDetails) {
            const sum = w.vacant + (w.reserved || 0) + (w.occupied || 0);
            if (sum !== w.total)
                throw new HttpError(400, `${w.ward}: counts must total ${w.total}`);
        }
    }
    const block = await db.prepare("SELECT name FROM blocks WHERE id=?")
        .get(blockId);
    if (!block)
        throw new HttpError(404, "Block not found");
    const shift = await userShift(userId);
    const round = currentRound(shift, minsNow());
    const key = roundKey(block.name, shift, todayStr(), round.startMin);
    try {
        await db.prepare(`INSERT INTO pre_rounds
         (pre_code, block_id, user_id, shift, round_key, start_min, submitted_at, snapshot)
       VALUES (?,?,?,?,?,?,?,?)`).run(block.name, blockId, userId, shift, key, round.startMin, Date.now(), JSON.stringify(wards));
    }
    catch { /* duplicate round key — idempotent */ }
    await audit(userId, "round_submit", block.name, { roundKey: key });
    return { ok: true, roundKey: key };
}

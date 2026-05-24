import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { wardsForPre } from "./bedService.js";
import { inShift, currentRound, roundKey, todayStr, minsNow, WARDS, } from "../config/domain.js";
export function userShift(userId) {
    const u = db.prepare("SELECT shift FROM users WHERE id = ?").get(userId);
    return u?.shift || "morning";
}
export function setShift(userId, shift) {
    db.prepare("UPDATE users SET shift=?, updated_at=? WHERE id=?").run(shift, Date.now(), userId);
}
export function alarmState(preCode, shift) {
    const mins = minsNow();
    const onDuty = inShift(shift, mins);
    const round = currentRound(shift, mins);
    const hasWards = (WARDS[preCode] || []).length > 0;
    const key = roundKey(preCode, shift, todayStr(), round.startMin);
    const submitted = !!db.prepare("SELECT 1 FROM pre_rounds WHERE round_key = ?").get(key);
    return { shift, onDuty, round, key, submitted, hasWards, alarmActive: onDuty && hasWards && !submitted };
}
export function submitRound(preCode, userId) {
    const wards = wardsForPre(preCode);
    if (wards.length === 0)
        throw new HttpError(400, "No wards to submit");
    for (const w of wards) {
        if (w.vacant === null)
            throw new HttpError(400, `Enter all wards first (${w.ward} missing)`);
        if ((w.vacant + (w.reserved || 0) + (w.occupied || 0)) !== w.total)
            throw new HttpError(400, `${w.ward}: counts must total ${w.total}`);
    }
    const shift = userShift(userId);
    const round = currentRound(shift, minsNow());
    const key = roundKey(preCode, shift, todayStr(), round.startMin);
    try {
        db.prepare("INSERT INTO pre_rounds (pre_code, user_id, shift, round_key, start_min, submitted_at, snapshot) VALUES (?,?,?,?,?,?,?)").run(preCode, userId, shift, key, round.startMin, Date.now(), JSON.stringify(wards));
    }
    catch { /* already submitted this round - idempotent */ }
    audit(userId, "round_submit", preCode, { roundKey: key });
    return { ok: true, roundKey: key };
}

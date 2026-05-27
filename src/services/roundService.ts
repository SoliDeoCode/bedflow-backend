import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { wardsForBlock } from "./bedService.js";
import {
  inShift, currentRound, roundKey, todayStr, minsNow, type ShiftKey,
} from "../config/domain.js";

export function userShift(userId: number): ShiftKey {
  const u = db.prepare("SELECT shift FROM users WHERE id=?").get<{ shift: ShiftKey }>(userId);
  return (u?.shift as ShiftKey) || "morning";
}

export function setShift(userId: number, shift: ShiftKey) {
  db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, Date.now(), userId);
}

/** Alarm state for a block (looked up by block name). */
export function alarmState(blockName: string, shift: ShiftKey) {
  const mins   = minsNow();
  const onDuty = inShift(shift, mins);
  const round  = currentRound(shift, mins);

  // hasWards: query DB — no more static WARDS config
  const block = db.prepare("SELECT id FROM blocks WHERE name_key = ?")
    .get<{ id: number }>(blockName.toUpperCase().trim());
  const hasWards = block
    ? (db.prepare("SELECT COUNT(*) AS n FROM wards WHERE block_id=?")
        .get<{ n: number }>(block.id)?.n ?? 0) > 0
    : false;

  const key       = roundKey(blockName, shift, todayStr(), round.startMin);
  const submitted = !!db.prepare("SELECT 1 FROM pre_rounds WHERE round_key=?").get(key);

  return { shift, onDuty, round, key, submitted, hasWards,
           alarmActive: onDuty && hasWards && !submitted };
}

/** Submit a round for the block the user is assigned to. */
export function submitRound(blockId: number, userId: number) {
  const wards = wardsForBlock(blockId);
  if (wards.length === 0) throw new HttpError(400, "No wards to submit");

  for (const w of wards) {
    if (w.vacant === null)
      throw new HttpError(400, `Enter all wards first (${w.ward} missing)`);
    if ((w.vacant + (w.reserved || 0) + (w.occupied || 0)) !== w.total)
      throw new HttpError(400, `${w.ward}: counts must total ${w.total}`);
  }

  const block = db.prepare("SELECT name FROM blocks WHERE id=?")
    .get<{ name: string }>(blockId);
  if (!block) throw new HttpError(404, "Block not found");

  const shift    = userShift(userId);
  const round    = currentRound(shift, minsNow());
  const key      = roundKey(block.name, shift, todayStr(), round.startMin);

  try {
    db.prepare(
      `INSERT INTO pre_rounds
         (pre_code, block_id, user_id, shift, round_key, start_min, submitted_at, snapshot)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(block.name, blockId, userId, shift, key, round.startMin, Date.now(), JSON.stringify(wards));
  } catch { /* duplicate round key — idempotent */ }

  audit(userId, "round_submit", block.name, { roundKey: key });
  return { ok: true, roundKey: key };
}

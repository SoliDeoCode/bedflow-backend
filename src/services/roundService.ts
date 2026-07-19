import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { wardsForFloor, wardsForPreBlock, type WardView } from "./bedService.js";
import { calculateWardTotals } from "./wardTotals.js";
import { currentRound, roundKey, todayStr, minsNow } from "../config/domain.js";

/** Alarm state for all PRE Blocks the user is assigned to. Every PRE user is on
 *  duty 24/7 — alarm is active whenever any assigned block has a pending round. */
export async function alarmState(preBlockIds: number[]) {
  const mins  = minsNow();
  const round = currentRound(mins);

  if (preBlockIds.length === 0)
    return { round, submitted: false, hasWards: false, alarmActive: false };

  const wardCountRow = await db.prepare(
    "SELECT COUNT(DISTINCT ward_id) AS n FROM pre_block_wards WHERE pre_block_id = ANY(?)"
  ).get<{ n: number }>(preBlockIds);
  const hasWards = (wardCountRow?.n ?? 0) > 0;

  const keys = preBlockIds.map(id => roundKey(`pb${id}`, todayStr(), round.startMin));
  const submittedRows = await db.prepare(
    "SELECT round_key FROM pre_rounds WHERE round_key = ANY(?)"
  ).all<{ round_key: string }>(keys);
  const submittedSet = new Set(submittedRows.map(r => r.round_key));
  const submitted = keys.every(k => submittedSet.has(k));

  return { round, submitted, hasWards, alarmActive: hasWards && !submitted };
}

/** Submit rounds for every PRE Block the user is assigned to. One pre_rounds row is inserted per block. */
export async function submitRounds(preBlockIds: number[], userId: number) {
  if (preBlockIds.length === 0)
    throw new HttpError(400, "No PRE Blocks assigned to your account");

  // Fetch wards per block and deduplicate for validation
  const blockWards = new Map<number, WardView[]>();
  for (const preBlockId of preBlockIds) {
    const wards = await wardsForPreBlock(preBlockId);
    if (wards.length === 0) throw new HttpError(400, "No wards assigned to this PRE Block");
    blockWards.set(preBlockId, wards);
  }

  // Deduplicate wards (a ward may appear in multiple blocks)
  const allWardsMap = new Map<number, WardView>();
  for (const wards of blockWards.values())
    for (const w of wards)
      if (!allWardsMap.has(w.id)) allWardsMap.set(w.id, w);

  const allWardIds = [...allWardsMap.keys()];
  const bedDetailRows = await db.prepare(
    `SELECT DISTINCT ward_id FROM bed_details WHERE ward_id = ANY(?)`
  ).all<{ ward_id: number }>(allWardIds);
  const wardHasBeds = new Set(bedDetailRows.map(r => Number(r.ward_id)));

  for (const w of allWardsMap.values()) {
    if (w.vacant === null)
      throw new HttpError(400, `Enter all wards first (${w.ward} missing)`);
    if (!wardHasBeds.has(w.id)) {
      const sum = calculateWardTotals(w).totalBeds;
      if (sum !== w.total)
        throw new HttpError(400, `${w.ward}: counts must total ${w.total}`);
    }
  }

  const round = currentRound(minsNow());
  const roundKeys: string[] = [];

  for (const [preBlockId, wards] of blockWards) {
    const key = roundKey(`pb${preBlockId}`, todayStr(), round.startMin);
    try {
      await db.prepare(
        `INSERT INTO pre_rounds
           (pre_code, pre_block_id, user_id, round_key, start_min, submitted_at, snapshot)
         VALUES (?,?,?,?,?,?,?)`
      ).run(`pb${preBlockId}`, preBlockId, userId, key, round.startMin, Date.now(), JSON.stringify(wards));
    } catch { /* duplicate round key — idempotent */ }
    await audit(userId, "round_submit", `pb${preBlockId}`, { roundKey: key });
    roundKeys.push(key);
  }

  return { ok: true, roundKeys };
}

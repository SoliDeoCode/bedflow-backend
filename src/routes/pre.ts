import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { wardsForBlock, summarize, updateWard } from "../services/bedService.js";
import { alarmState, setShift, userShift, submitRound } from "../services/roundService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("PRE"));

/** Return the block_id + block_name for the authenticated PRE user. */
function myBlock(req: { user?: { id: number } }) {
  const row = db.prepare(
    `SELECT u.block_id, b.name AS block_name
     FROM users u
     JOIN blocks b ON b.id = u.block_id
     WHERE u.id = ?`
  ).get<{ block_id: number; block_name: string }>(req.user!.id);
  if (!row) throw new HttpError(400, "No block assigned to your account");
  return row;
}

router.get("/me", asyncH(async (req, res) => {
  const { block_id, block_name } = myBlock(req);
  const wards = wardsForBlock(block_id);
  const shift = userShift(req.user!.id);
  res.json({
    block: block_name,
    pre:   block_name,    // legacy alias for PREApp.jsx that reads data.pre
    floor: block_name,    // legacy alias for PREApp.jsx that reads data.floor
    wards,
    summary: summarize(wards),
    alarm:   alarmState(block_name, shift),
    label:   `Block ${block_name}`,
  });
}));

router.post("/shift", asyncH(async (req, res) => {
  const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
  setShift(req.user!.id, shift);
  res.json({ ok: true, shift });
}));

router.post("/ward", asyncH(async (req, res) => {
  const { block_id } = myBlock(req);
  const { wardId, vacant, reserved } = z.object({
    wardId: z.number().int(), vacant: z.number().int().min(0), reserved: z.number().int().min(0),
  }).parse(req.body);

  // Verify the ward belongs to this user's block
  const owns = db.prepare("SELECT 1 FROM wards WHERE id=? AND block_id=?").get(wardId, block_id);
  if (!owns) throw new HttpError(403, "Ward not assigned to your block");

  const result = updateWard(wardId, vacant, reserved, req.user!.id);
  const blockName = db.prepare("SELECT name FROM blocks WHERE id=?")
    .get<{ name: string }>(block_id)?.name ?? "";
  emitUpdate("bed:update", { block: blockName, ...result }, blockName);
  res.json({ ok: true, ...result });
}));

router.post("/submit", asyncH(async (req, res) => {
  const { block_id, block_name } = myBlock(req);
  const result = submitRound(block_id, req.user!.id);
  emitUpdate("round:submit", { block: block_name }, block_name);
  res.json(result);
}));

export default router;

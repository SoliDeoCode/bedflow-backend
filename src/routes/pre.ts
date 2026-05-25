import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { wardsForPre, summarize, updateWard } from "../services/bedService.js";
import { alarmState, setShift, userShift, submitRound } from "../services/roundService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("PRE"));

function myPre(req: { user?: { pre?: string | null } }): string {
  const pre = req.user?.pre;
  if (!pre) throw new HttpError(400, "No PRE assignment");
  return pre;
}

router.get("/me", asyncH(async (req, res) => {
  const pre = myPre(req);
  const wards = wardsForPre(pre);
  const shift = userShift(req.user!.id);
  // floor + label for the dashboard header
  const fl = db.prepare(
    "SELECT f.name AS floor FROM wards w LEFT JOIN floors f ON f.id=w.floor_id WHERE w.pre_code=? LIMIT 1"
  ).get<{ floor: string }>(pre);
  res.json({
    pre, wards, summary: summarize(wards), alarm: alarmState(pre, shift),
    floor: fl?.floor ?? "Pending", label: pre.replace("PRE-", "Premium "),
  });
}));

router.post("/shift", asyncH(async (req, res) => {
  const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
  setShift(req.user!.id, shift);
  res.json({ ok: true, shift });
}));

router.post("/ward", asyncH(async (req, res) => {
  const pre = myPre(req);
  const { wardId, vacant, reserved } = z.object({
    wardId: z.number().int(), vacant: z.number().int().min(0), reserved: z.number().int().min(0),
  }).parse(req.body);
  // verify ward belongs to this PRE
  const owns = db.prepare("SELECT 1 FROM wards WHERE id=? AND pre_code=?").get(wardId, pre);
  if (!owns) throw new HttpError(403, "Ward not assigned to you");
  const result = updateWard(wardId, vacant, reserved, req.user!.id);
  emitUpdate("bed:update", { pre, ...result }, pre);
  res.json({ ok: true, ...result });
}));

router.post("/submit", asyncH(async (req, res) => {
  const pre = myPre(req);
  const result = submitRound(pre, req.user!.id);
  emitUpdate("round:submit", { pre }, pre);
  res.json(result);
}));

export default router;

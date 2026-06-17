import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { wardsForPreBlock, summarize, updateWard } from "../services/bedService.js";
import { alarmState, setShift, userShift, submitRound } from "../services/roundService.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("PRE"));

/** Return the pre_block_id + display label for the authenticated PRE user — always reads from DB so reassignments take effect immediately without waiting for JWT expiry. */
async function myPreBlock(req: { user?: { id: number } }) {
  const row = await db.prepare("SELECT pre_block_id FROM users WHERE id=?")
    .get<{ pre_block_id: number | null }>(req.user!.id);
  const preBlockId = row?.pre_block_id;

  if (!preBlockId) throw new HttpError(400, "No PRE Block assigned to your account");

  const block = await db.prepare(
    "SELECT id, name FROM pre_blocks WHERE id=?"
  ).get<{ id: number; name: string }>(preBlockId);

  if (!block) throw new HttpError(400, "Assigned PRE Block not found");
  return block;
}

router.get("/me", asyncH(async (req, res) => {
  const block = await myPreBlock(req);
  const wards = await wardsForPreBlock(block.id);
  const shift = await userShift(req.user!.id);
  res.json({
    preBlockId: block.id,
    preBlockName: block.name,
    pre:    block.name,
    floor:  block.name,
    label:  block.name,
    wards,
    summary: summarize(wards),
    alarm:   await alarmState(block.id, shift),
  });
}));

router.post("/shift", asyncH(async (req, res) => {
  const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
  await setShift(req.user!.id, shift);
  res.json({ ok: true, shift });
}));

router.post("/ward", asyncH(async (req, res) => {
  const block = await myPreBlock(req);
  const { wardId, vacant_none, vacant_reserved, occupied_none, occupied_reserved } = z.object({
    wardId:            z.number().int(),
    vacant_none:       z.number().int().min(0),
    vacant_reserved:   z.number().int().min(0),
    occupied_none:     z.number().int().min(0),
    occupied_reserved: z.number().int().min(0).default(0),
  }).parse(req.body);

  const owns = await db.prepare(
    "SELECT 1 FROM pre_block_wards WHERE pre_block_id=? AND ward_id=?"
  ).get(block.id, wardId);
  if (!owns) throw new HttpError(403, "Ward not in your PRE Block");

  const result = await updateWard(wardId, vacant_none, vacant_reserved, occupied_none, occupied_reserved, req.user!.id);
  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(wardId);
  emitUpdate("bed:update", { floor: block.name, wardId, ...result }, {
    pre: String(block.id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json({ ok: true, ...result });
}));

router.post("/submit", asyncH(async (req, res) => {
  const block = await myPreBlock(req);
  const result = await submitRound(block.id, req.user!.id);
  emitUpdate("round:submit", { floor: block.name }, { pre: String(block.id) });
  res.json(result);
}));

// ── bed-level tracking ────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const block = await myPreBlock(req);
  const wardId = Number(req.params.id);
  if (!await db.prepare("SELECT 1 FROM pre_block_wards WHERE pre_block_id=? AND ward_id=?").get(block.id, wardId))
    throw new HttpError(403, "Ward not in your PRE Block");
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus, false) });
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const block = await myPreBlock(req);
  const bedId = Number(req.params.id);
  const { physical_status, reservation_status, payer_type } = z.object({
    physical_status:    z.enum(["VACANT", "OCCUPIED"]),
    reservation_status: z.enum(["NONE", "RESERVED"]),
    payer_type:         z.string().max(100).nullable().optional(),
  }).parse(req.body);

  const owns = await db.prepare(
    `SELECT bd.id FROM bed_details bd
     JOIN pre_block_wards pbw ON pbw.ward_id = bd.ward_id
     WHERE bd.id = ? AND pbw.pre_block_id = ?`
  ).get(bedId, block.id);
  if (!owns) throw new HttpError(403, "Bed not in your PRE Block");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, userId: req.user!.id,
  });

  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(result.ward_id);

  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type,
  }, {
    pre: String(block.id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json(result);
}));

export default router;

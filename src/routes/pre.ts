import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { wardsGroupedByBlock, summarize, updateWard, type WardView } from "../services/bedService.js";
import { alarmState, setShift, userShift, submitRounds } from "../services/roundService.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("PRE"));

/** All PRE Blocks the authenticated PRE user is assigned to. Throws 400 if none. */
async function myPreBlocks(req: { user?: { id: number } }) {
  const rows = await db.prepare(
    `SELECT pb.id, pb.name
     FROM user_pre_blocks upb
     JOIN pre_blocks pb ON pb.id = upb.pre_block_id
     WHERE upb.user_id = ?
     ORDER BY pb.name`
  ).all<{ id: number; name: string }>(req.user!.id);

  if (rows.length === 0)
    throw new HttpError(400, "No PRE Block assigned to your account");

  return rows;
}

router.get("/me", asyncH(async (req, res) => {
  const blocks  = await myPreBlocks(req);
  const grouped = await wardsGroupedByBlock(req.user!.id);
  const shift   = await userShift(req.user!.id);
  const label   = blocks.map(b => b.name).join(", ");
  // Flat deduplicated ward list for summary + backwards compat
  const wardMap = new Map<number, WardView>();
  for (const b of grouped) for (const w of b.wards) if (!wardMap.has(w.id)) wardMap.set(w.id, w);
  const wards = [...wardMap.values()];
  res.json({
    preBlockIds:   blocks.map(b => b.id),
    preBlockId:    blocks[0].id,   // legacy field
    preBlockNames: blocks.map(b => b.name),
    preBlockName:  label,
    pre:   label,
    floor: label,
    label,
    blocks: grouped,   // grouped by block — used for section headers in Entry tab
    wards,             // flat deduped list — used for summary, alarmState, MyMap
    summary: summarize(wards),
    alarm:   await alarmState(blocks.map(b => b.id), shift),
  });
}));

router.post("/shift", asyncH(async (req, res) => {
  const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
  await setShift(req.user!.id, shift);
  res.json({ ok: true, shift });
}));

router.post("/ward", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const { wardId, vacant_none, vacant_reserved, occupied_none, occupied_reserved } = z.object({
    wardId:            z.number().int(),
    vacant_none:       z.number().int().min(0),
    vacant_reserved:   z.number().int().min(0),
    occupied_none:     z.number().int().min(0),
    occupied_reserved: z.number().int().min(0).default(0),
  }).parse(req.body);

  // Ward must belong to at least one of the user's blocks
  const ownRow = await db.prepare(
    "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=? AND pre_block_id = ANY(?)"
  ).get<{ pre_block_id: number }>(wardId, blockIds);
  if (!ownRow) throw new HttpError(403, "Ward not in your PRE Block");

  const result = await updateWard(wardId, vacant_none, vacant_reserved, occupied_none, occupied_reserved, req.user!.id);
  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(wardId);
  const blockName = blocks.find(b => b.id === ownRow.pre_block_id)?.name ?? "";
  emitUpdate("bed:update", { floor: blockName, wardId, ...result }, {
    pre: String(ownRow.pre_block_id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json({ ok: true, ...result });
}));

router.post("/submit", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const result = await submitRounds(blocks.map(b => b.id), req.user!.id);
  for (const block of blocks)
    emitUpdate("round:submit", { floor: block.name }, { pre: String(block.id) });
  res.json(result);
}));

// ── bed-level tracking ────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const wardId = Number(req.params.id);
  if (!await db.prepare(
    "SELECT 1 FROM pre_block_wards WHERE ward_id=? AND pre_block_id = ANY(?)"
  ).get(wardId, blockIds))
    throw new HttpError(403, "Ward not in your PRE Block");
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus, false) });
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations(true) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const bedId = Number(req.params.id);
  const { physical_status, reservation_status, payer_type, destination, reservation_note, ip_last6, admission_type, consultant_name, department_name, doctor_id, department_id } = z.object({
    physical_status:    z.enum(["VACANT", "OCCUPIED"]),
    reservation_status: z.enum(["NONE", "RESERVED"]),
    payer_type:         z.string().max(100).nullable().optional(),
    destination:        z.string().max(100).nullable().optional(),
    reservation_note:   z.string().max(255).nullable().optional(),
    ip_last6:           z.string().max(6).optional(),
    admission_type:     z.enum(["IP", "DAYCARE", "OPD"]).optional(),
    consultant_name:    z.string().max(120).nullable().optional(),
    department_name:    z.string().max(120).nullable().optional(),
    doctor_id:          z.number().int().positive().nullable().optional(),
    department_id:      z.number().int().positive().nullable().optional(),
  }).parse(req.body);

  // Bed must belong to a ward that's in one of the user's blocks
  const owns = await db.prepare(
    `SELECT bd.id, pbw.pre_block_id FROM bed_details bd
     JOIN pre_block_wards pbw ON pbw.ward_id = bd.ward_id
     WHERE bd.id = ? AND pbw.pre_block_id = ANY(?)`
  ).get<{ id: number; pre_block_id: number }>(bedId, blockIds);
  if (!owns) throw new HttpError(403, "Bed not in your PRE Block");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, destination, reservationNote: reservation_note, userId: req.user!.id,
    ipLast6: ip_last6, admissionType: admission_type, consultantName: consultant_name, departmentName: department_name,
    doctorId: doctor_id, departmentId: department_id,
  });

  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(result.ward_id);

  const blockName = blocks.find(b => b.id === owns.pre_block_id)?.name ?? "";
  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type, destination: result.destination, reservationNote: result.reservation_note,
    floor: blockName,
  }, {
    pre: String(owns.pre_block_id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json(result);
}));

export default router;

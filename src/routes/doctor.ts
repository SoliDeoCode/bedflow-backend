import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { audit } from "../services/auditService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("DOCTOR"));

// ── Access helpers ────────────────────────────────────────────────────────────
// A doctor can reach a ward iff it sits in one of their ACTIVE doctor blocks.

interface WardAccess { ward_id: number; doctor_block_id: number; }

export async function accessibleWards(doctorId: number): Promise<WardAccess[]> {
  return db.prepare(
    `SELECT dbw.ward_id, dbw.doctor_block_id
     FROM doctor_block_users dbu
     JOIN doctor_blocks db       ON db.id = dbu.doctor_block_id AND db.status = 'active'
     JOIN doctor_block_wards dbw ON dbw.doctor_block_id = db.id
     WHERE dbu.user_id = ?`
  ).all<WardAccess>(doctorId);
}

export async function blockForWard(doctorId: number, wardId: number): Promise<number | null> {
  const rows = await accessibleWards(doctorId);
  const hit = rows.find((r) => Number(r.ward_id) === wardId);
  return hit ? Number(hit.doctor_block_id) : null;
}

// Resolve the PRE block + station for a ward so a doctor's change fans out to
// the Admin overview, the PRE dashboard, the Nurse dashboard AND other doctors.
async function fanoutRooms(wardId: number) {
  const pre = await db.prepare("SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?")
    .get<{ pre_block_id: number }>(wardId);
  const ward = await db.prepare("SELECT station_id FROM wards WHERE id=?")
    .get<{ station_id: number | null }>(wardId);
  return {
    wardId,
    pre: pre ? String(pre.pre_block_id) : undefined,
    stationId: ward?.station_id ?? undefined,
  };
}

// ── Dashboard / blocks ────────────────────────────────────────────────────────

router.get("/me", asyncH(async (req, res) => {
  const doctorId = req.user!.id;
  const blocks = await db.prepare(
    `SELECT db.id, db.name, db.description,
            COUNT(DISTINCT dbw.ward_id)::int AS ward_count,
            COALESCE(SUM(w.total_beds)::int, 0) AS total_beds
     FROM doctor_block_users dbu
     JOIN doctor_blocks db       ON db.id = dbu.doctor_block_id AND db.status = 'active'
     LEFT JOIN doctor_block_wards dbw ON dbw.doctor_block_id = db.id
     LEFT JOIN wards w                ON w.id = dbw.ward_id
     WHERE dbu.user_id = ?
     GROUP BY db.id
     ORDER BY db.name`
  ).all(doctorId);

  // Aggregate live bed summary across every accessible ward.
  const wards = await accessibleWards(doctorId);
  const wardIds = [...new Set(wards.map((w) => Number(w.ward_id)))];
  let summary = { total: 0, vacant: 0, reserved: 0, occupied: 0, occupied_reserved: 0 };
  if (wardIds.length) {
    const s = await db.prepare(
      `SELECT COALESCE(SUM(total),0)::int AS total,
              COALESCE(SUM(vacant),0)::int AS vacant,
              COALESCE(SUM(reserved),0)::int AS reserved,
              COALESCE(SUM(occupied),0)::int AS occupied,
              COALESCE(SUM(occupied_reserved),0)::int AS occupied_reserved
       FROM beds WHERE ward_id = ANY(?)`
    ).get<typeof summary>(wardIds);
    if (s) summary = s;
  }

  res.json({ blocks, wardCount: wardIds.length, summary });
}));

router.get("/blocks/:id", asyncH(async (req, res) => {
  const doctorId = req.user!.id;
  const blockId = Number(req.params.id);

  const membership = await db.prepare(
    "SELECT 1 FROM doctor_block_users WHERE user_id=? AND doctor_block_id=?"
  ).get(doctorId, blockId);
  if (!membership) throw new HttpError(403, "You are not assigned to this Doctor Block");

  const block = await db.prepare("SELECT id, name, description, status FROM doctor_blocks WHERE id=?")
    .get<{ id: number; name: string; description: string | null; status: string }>(blockId);
  if (!block) throw new HttpError(404, "Doctor Block not found");
  if (block.status !== "active") throw new HttpError(409, "This Doctor Block is inactive. Contact administrator.");

  const wards = await db.prepare(
    `SELECT w.id, w.name, w.total_beds, w.unit_type, w.operational,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved,
            f.name AS floor_name, bb.name AS block_name
     FROM doctor_block_wards dbw
     JOIN wards w ON w.id = dbw.ward_id
     LEFT JOIN beds b ON b.ward_id = w.id
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     WHERE dbw.doctor_block_id = ?
     ORDER BY bb.name NULLS LAST, f.name NULLS LAST, w.name`
  ).all(blockId);

  const doctors = await db.prepare(
    `SELECT u.id, u.name, u.username FROM doctor_block_users dbu
     JOIN users u ON u.id = dbu.user_id
     WHERE dbu.doctor_block_id = ? ORDER BY u.name`
  ).all(blockId);

  // Header "reviewed" = newest review of any kind for this block.
  const headerReviewed = await db.prepare(
    "SELECT MAX(reviewed_at) AS reviewed_at FROM doctor_block_reviews WHERE doctor_block_id=?"
  ).get<{ reviewed_at: number | null }>(blockId);
  // Block-wide review (ward_id NULL) applies to every ward in the block.
  const blockWideRow = await db.prepare(
    "SELECT MAX(reviewed_at) AS reviewed_at FROM doctor_block_reviews WHERE doctor_block_id=? AND ward_id IS NULL"
  ).get<{ reviewed_at: number | null }>(blockId);
  const blockWide = blockWideRow?.reviewed_at ?? 0;
  // A single-ward review applies to that ward only.
  const wardReviews = await db.prepare(
    `SELECT ward_id, MAX(reviewed_at) AS reviewed_at
     FROM doctor_block_reviews
     WHERE doctor_block_id = ? AND ward_id IS NOT NULL
     GROUP BY ward_id`
  ).all<{ ward_id: number; reviewed_at: number }>(blockId);
  const wardReviewMap = new Map(wardReviews.map((r) => [Number(r.ward_id), Number(r.reviewed_at)]));
  const wardsWithReview = (wards as Array<Record<string, unknown>>).map((w) => {
    const rv = Math.max(wardReviewMap.get(Number(w.id)) ?? 0, blockWide) || null;
    return { ...w, reviewedAt: rv };
  });

  res.json({ ...block, wards: wardsWithReview, doctors, reviewedAt: headerReviewed?.reviewed_at ?? null });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const doctorId = req.user!.id;
  const wardId = Number(req.params.id);
  if (!(await blockForWard(doctorId, wardId)))
    throw new HttpError(403, "This ward is not in your assigned Doctor Blocks");

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

// ── Bed update (optimistic-locked, fans out to everyone) ────────────────────────

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const doctorId = req.user!.id;
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

  // Read current bed first (for the doctor activity log) + authorize the ward.
  const bed = await db.prepare(
    "SELECT id, ward_id, bed_name, physical_status, reservation_status FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_name: string; physical_status: string; reservation_status: string }>(bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  const doctorBlockId = await blockForWard(doctorId, bed.ward_id);
  if (!doctorBlockId) throw new HttpError(403, "You do not have access to this bed");

  // Reuses the shared service: optimistic lock (409 on conflict), bed_movements
  // history, ward-total recalc — identical to nurse/PRE updates.
  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, destination, reservationNote: reservation_note, userId: doctorId,
    ipLast6: ip_last6, admissionType: admission_type, consultantName: consultant_name, departmentName: department_name,
    doctorId: doctor_id, departmentId: department_id,
  });

  // Doctor-specific audit with ip/device, in addition to bed_movements + audit_logs.
  await db.prepare(
    `INSERT INTO doctor_activity_logs
       (user_id, doctor_block_id, ward_id, bed_id, bed_name,
        old_physical, new_physical, old_reservation, new_reservation,
        ip_address, device_info, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(doctorId, doctorBlockId, bed.ward_id, bedId, bed.bed_name,
        bed.physical_status, physical_status, bed.reservation_status, reservation_status,
        (req.ip || "").slice(0, 64), String(req.headers["user-agent"] || "").slice(0, 500), Date.now());

  // Fan out: Admin overview + PRE dashboard + Nurse dashboard + other doctors.
  const rooms = await fanoutRooms(result.ward_id);
  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type, destination: result.destination, reservationNote: result.reservation_note,
  }, rooms);

  res.json(result);
}));

// ── Review-confirm (manual "reviewed" stamp over a block's wards) ───────────────

router.post("/blocks/:id/review", asyncH(async (req, res) => {
  const doctorId = req.user!.id;
  const blockId = Number(req.params.id);
  const membership = await db.prepare(
    "SELECT 1 FROM doctor_block_users WHERE user_id=? AND doctor_block_id=?"
  ).get(doctorId, blockId);
  if (!membership) throw new HttpError(403, "You are not assigned to this Doctor Block");

  const wards = await db.prepare("SELECT ward_id FROM doctor_block_wards WHERE doctor_block_id=?")
    .all<{ ward_id: number }>(blockId);
  if (wards.length === 0) throw new HttpError(400, "This Doctor Block has no wards to review");

  const t = Date.now();
  // ward_id NULL = block-wide review (applies to every ward in the block).
  await db.prepare(
    "INSERT INTO doctor_block_reviews (doctor_block_id, ward_id, user_id, reviewed_at) VALUES (?,NULL,?,?)"
  ).run(blockId, doctorId, t);
  await audit(doctorId, "doctor_block_review", String(blockId), { wardCount: wards.length });

  // Surface the new "reviewed" time on the Admin dashboard (overview + ward rooms).
  emitUpdate("bed:update", { doctorBlockId: blockId, reviewedAt: t },
    { wardId: wards.map((w) => Number(w.ward_id)) });
  res.json({ ok: true, reviewedAt: t });
}));

router.post("/wards/:id/review", asyncH(async (req, res) => {
  const doctorId = req.user!.id;
  const wardId = Number(req.params.id);
  const doctorBlockId = await blockForWard(doctorId, wardId);
  if (!doctorBlockId) throw new HttpError(403, "This ward is not in your assigned Doctor Blocks");

  const t = Date.now();
  await db.prepare(
    "INSERT INTO doctor_block_reviews (doctor_block_id, ward_id, user_id, reviewed_at) VALUES (?,?,?,?)"
  ).run(doctorBlockId, wardId, doctorId, t);
  await audit(doctorId, "doctor_ward_review", String(wardId), { doctorBlockId });

  emitUpdate("bed:update", { doctorBlockId, wardId, reviewedAt: t }, { wardId });
  res.json({ ok: true, reviewedAt: t });
}));

// ── Own activity ────────────────────────────────────────────────────────────────

router.get("/activity", asyncH(async (req, res) => {
  const rows = await db.prepare(
    `SELECT dal.id, dal.bed_name, dal.old_physical, dal.new_physical,
            dal.old_reservation, dal.new_reservation, dal.created_at,
            w.name AS ward_name, db.name AS block_name
     FROM doctor_activity_logs dal
     LEFT JOIN wards w          ON w.id = dal.ward_id
     LEFT JOIN doctor_blocks db ON db.id = dal.doctor_block_id
     WHERE dal.user_id = ?
     ORDER BY dal.created_at DESC
     LIMIT 100`
  ).all(req.user!.id);
  res.json({ activity: rows });
}));

export default router;

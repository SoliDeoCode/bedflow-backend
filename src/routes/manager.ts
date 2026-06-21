import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { db } from "../db/index.js";
import { emitUpdate } from "../websocket/io.js";
import {
  listBuildingBlocks, createBuildingBlock, editBuildingBlock, deleteBuildingBlock,
  listFloors, createFloor, editFloor, deleteFloor,
  createWard, editWard, deleteWard,
  createPre, editPre, setPreShift, deletePre,
  createNurse, editNurse, deleteNurse,
  createDoctor, editDoctor, deleteDoctor,
  listNursingStations, createNursingStation, editNursingStation, deleteNursingStation, assignWardsToStation,
  availableDates, censusDates, historyForDate,
  listNurseAccess, createNurseAccess, editNurseAccess, deleteNurseAccess,
} from "../services/managerService.js";
import {
  listPreBlocks, getPreBlock, createPreBlock, editPreBlock,
  setPreBlockStatus, deletePreBlock,
} from "../services/preBlockService.js";
import {
  listDoctorBlocks, getDoctorBlock, createDoctorBlock, editDoctorBlock,
  setDoctorBlockStatus, deleteDoctorBlock, wardIdsForDoctorBlock,
} from "../services/doctorBlockService.js";
import {
  generateBeds, addSingleBed, listBeds, renameBed, deleteBed, updateBedMaster,
} from "../services/bedDetailService.js";
import { midnightCensusFor } from "../services/bedService.js";
import {
  listPayerTypes, createPayerType, updatePayerType, reorderPayerType, deletePayerType,
} from "../services/payerTypeService.js";
import {
  listDestinations, createDestination, updateDestination, reorderDestination, deleteDestination,
} from "../services/destinationService.js";

const router = Router();
router.use(authRequired, requireRole("COO"));

// Nurses only join the `station:<id>` socket room, not `overview` — these
// helpers let mutation routes target the right nurse station(s) so an Admin's
// edit is visible on the nurse's dashboard too, not just the Admin's.
async function stationIdForWard(wardId: number): Promise<number | undefined> {
  const row = await db.prepare("SELECT station_id FROM wards WHERE id=?")
    .get<{ station_id: number | null }>(wardId);
  return row?.station_id ?? undefined;
}
async function stationIdForBed(bedId: number): Promise<number | undefined> {
  const row = await db.prepare(
    "SELECT w.station_id FROM bed_details bd JOIN wards w ON w.id=bd.ward_id WHERE bd.id=?"
  ).get<{ station_id: number | null }>(bedId);
  return row?.station_id ?? undefined;
}
async function stationIdForNurse(nurseId: number): Promise<number | undefined> {
  const row = await db.prepare("SELECT station_id FROM users WHERE id=?")
    .get<{ station_id: number | null }>(nurseId);
  return row?.station_id ?? undefined;
}

// ── KPIs ──────────────────────────────────────────────────────────────────────

router.get("/kpis", asyncH(async (_req, res) => {
  const row = await db.prepare(`
    SELECT
      COUNT(*)::int                                                            AS total,
      COUNT(*) FILTER (WHERE (w.bed_type = 'Census' OR w.bed_type IS NULL) AND bd.operational_status)::int AS census,
      COUNT(*) FILTER (WHERE w.bed_type = 'Non-Census')::int                  AS non_census,
      COUNT(*) FILTER (WHERE bd.operational_status)::int                      AS operational,
      COUNT(*) FILTER (WHERE NOT bd.operational_status)::int                  AS non_operational,
      COUNT(*) FILTER (WHERE bd.physical_status = 'VACANT'
                         AND bd.reservation_status = 'NONE'
                         AND bd.operational_status)::int                      AS vacant,
      COUNT(*) FILTER (WHERE bd.physical_status = 'VACANT'
                         AND bd.reservation_status = 'RESERVED')::int         AS vacant_reserved,
      COUNT(*) FILTER (WHERE bd.physical_status = 'OCCUPIED')::int             AS occupied
    FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
  `).get<Record<string, number>>();
  const occupiedTotal = row?.occupied ?? 0;
  const operational   = row?.operational ?? 0;
  res.json({
    ...row,
    occupancy_pct: operational > 0 ? Math.round((occupiedTotal / operational) * 100) : 0,
    census_occupancy_pct: (row?.census ?? 0) > 0
      ? Math.round((occupiedTotal / row!.census) * 100) : 0,
  });
}));

// ── building blocks ───────────────────────────────────────────────────────────

router.get("/building-blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listBuildingBlocks() });
}));

router.post("/building-blocks", asyncH(async (req, res) => {
  const { name, label } = z.object({
    name:  z.string().min(1).max(10),
    label: z.string().optional(),
  }).parse(req.body);
  const result = await createBuildingBlock({ name, label, managerId: req.user!.id });
  emitUpdate("bed:update", { blockId: result.id });
  res.status(201).json(result);
}));

router.put("/building-blocks/:id", asyncH(async (req, res) => {
  const { name, label, sortOrder } = z.object({
    name:      z.string().optional(),
    label:     z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).parse(req.body);
  const blockId = Number(req.params.id);
  const result = await editBuildingBlock({
    blockId, name, label: label ?? undefined, sortOrder, managerId: req.user!.id,
  });
  emitUpdate("bed:update", { blockId });
  res.json(result);
}));

router.delete("/building-blocks/:id", asyncH(async (req, res) => {
  const blockId = Number(req.params.id);
  const result = await deleteBuildingBlock(blockId, req.user!.id);
  emitUpdate("bed:update", { blockId });
  res.json(result);
}));

// ── floors ────────────────────────────────────────────────────────────────────

router.get("/floors", asyncH(async (_req, res) => {
  res.json({ floors: await listFloors() });
}));

router.post("/floors", asyncH(async (req, res) => {
  const { name, buildingBlockId } = z.object({
    name:            z.string().min(1).max(60),
    buildingBlockId: z.number().int(),
  }).parse(req.body);
  const result = await createFloor({ name, buildingBlockId, managerId: req.user!.id });
  emitUpdate("bed:update", { floorId: result.id });
  res.status(201).json(result);
}));

router.put("/floors/:id", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
  const floorId = Number(req.params.id);
  const result = await editFloor({ floorId, name, managerId: req.user!.id });
  emitUpdate("bed:update", { floorId });
  res.json(result);
}));

router.delete("/floors/:id", asyncH(async (req, res) => {
  const floorId = Number(req.params.id);
  const result = await deleteFloor(floorId, req.user!.id);
  emitUpdate("bed:update", { floorId });
  res.json(result);
}));

// ── wards ─────────────────────────────────────────────────────────────────────

router.get("/unit-types", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT DISTINCT unit_type FROM wards WHERE unit_type IS NOT NULL AND unit_type <> '' ORDER BY unit_type"
  ).all<{ unit_type: string }>();
  res.json({ unitTypes: rows.map((r) => r.unit_type) });
}));

router.get("/wards", asyncH(async (_req, res) => {
  const wards = await db.prepare(
    `SELECT w.id, w.name, w.floor_id, w.total_beds,
            w.nursing_station, w.station_id, w.unit_type, w.room_type,
            w.bed_type, w.operational,
            ns.name  AS station_name,
            f.name AS floor_name,
            bb.id    AS block_id,    bb.name AS block_name,
            (SELECT COUNT(*)::int FROM bed_details bd WHERE bd.ward_id = w.id) AS bed_count
     FROM wards w
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     LEFT JOIN nursing_stations ns ON ns.id = w.station_id
     ORDER BY bb.sort_order, bb.name, f.sort_order, f.name, w.name`
  ).all();
  res.json({ wards });
}));

router.post("/wards", asyncH(async (req, res) => {
  const b = z.object({
    name:        z.string().min(1),
    floorId:     z.number().int(),
    totalBeds:   z.number().int().min(0).max(500, "A ward can have at most 500 beds. Create it, then add more beds individually."),
    stationId:   z.number().int().nullable().optional(),
    unitType:    z.string().optional(),
    roomType:    z.string().optional(),
    bedType:     z.enum(["Census", "Non-Census"]).optional(),
    operational: z.boolean().optional(),
  }).parse(req.body);
  const result = await createWard({ ...b, managerId: req.user!.id });
  emitUpdate("bed:update", { wardId: result.id }, b.stationId ? { stationId: b.stationId } : undefined);
  res.status(201).json(result);
}));

router.put("/wards/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:        z.string().optional(),
    totalBeds:   z.number().int().min(0).optional(),
    floorId:     z.number().int().optional(),
    stationId:   z.number().int().nullable().optional(),
    unitType:    z.string().nullable().optional(),
    roomType:    z.string().nullable().optional(),
    bedType:     z.enum(["Census", "Non-Census"]).nullable().optional(),
    operational: z.boolean().nullable().optional(),
  }).parse(req.body);
  const wardId = Number(req.params.id);
  const prevStationId = await stationIdForWard(wardId);
  const result = await editWard({ wardId, ...b, managerId: req.user!.id });
  const newStationId = b.stationId !== undefined ? (b.stationId ?? undefined) : prevStationId;
  const stationIds = [...new Set([prevStationId, newStationId].filter((v): v is number => v != null))];
  emitUpdate("bed:update", { wardId }, stationIds.length ? { stationId: stationIds } : undefined);
  if (b.operational != null) {
    const blocks = await db.prepare(
      "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?"
    ).all<{ pre_block_id: number }>(wardId);
    emitUpdate("ward:operational", { wardId, operational: b.operational }, {
      pre: blocks.map(r => String(r.pre_block_id)),
    });
  }
  res.json(result);
}));

router.delete("/wards/:id", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  const stationId = await stationIdForWard(wardId);
  const result = await deleteWard(wardId, req.user!.id);
  emitUpdate("bed:update", { wardId }, stationId ? { stationId } : undefined);
  res.json(result);
}));

// ── users list ────────────────────────────────────────────────────────────────

router.get("/users", asyncH(async (_req, res) => {
  const users = await db.prepare(
    `SELECT u.id, u.username, u.role, u.name, u.shift, u.status, u.remarks,
            u.pre_block_id, u.station_id, u.nursing_station,
            pb.name AS pre_block_name,
            ns.name AS station_name
     FROM users u
     LEFT JOIN pre_blocks pb ON pb.id = u.pre_block_id
     LEFT JOIN nursing_stations ns ON ns.id = u.station_id
     ORDER BY u.role, u.username`
  ).all();
  res.json({ users });
}));

// ── PRE users ─────────────────────────────────────────────────────────────────

router.post("/pre", asyncH(async (req, res) => {
  const b = z.object({
    username:    z.string().min(1, "Username is required.").max(40, "Username must be 40 characters or less."),
    password:    z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long."),
    name:        z.string().min(1, "Display name is required.").max(80, "Display name is too long."),
    preBlockId:  z.number().int().nullable().optional(),
    shift:       z.enum(["morning", "night"]).optional(),
  }).parse(req.body);
  res.status(201).json(await createPre({ ...b, managerId: req.user!.id }));
}));

router.put("/pre/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:        z.string().min(1, "Display name is required.").max(80, "Display name is too long.").optional(),
    password:    z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long.").optional(),
    shift:       z.enum(["morning", "night"]).optional(),
    preBlockId:  z.number().int().nullable().optional(),
  }).parse(req.body);
  res.json(await editPre({ userId: Number(req.params.id), ...b, managerId: req.user!.id }));
}));

router.post("/pre/:id/shift", asyncH(async (req, res) => {
  const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
  res.json(await setPreShift(Number(req.params.id), shift, req.user!.id));
}));

router.delete("/pre/:id", asyncH(async (req, res) => {
  res.json(await deletePre(Number(req.params.id), req.user!.id));
}));

// ── Nurse In-Charge users ─────────────────────────────────────────────────────

const nurseProfileFields = {
  stationId:  z.number().int().positive().nullable().optional(),
  employeeId: z.string().max(50).optional(),
  phone:      z.string().max(30).optional(),
  email:      z.string().max(120).optional(),
};

router.post("/nurses", asyncH(async (req, res) => {
  const b = z.object({
    username: z.string().min(1, "Username is required.").max(40, "Username must be 40 characters or less."),
    password: z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long."),
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long."),
    ...nurseProfileFields,
  }).parse(req.body);
  res.status(201).json(await createNurse({ ...b, managerId: req.user!.id }));
}));

router.put("/nurses/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long.").optional(),
    password: z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long.").optional(),
    ...nurseProfileFields,
  }).parse(req.body);
  res.json(await editNurse({ userId: Number(req.params.id), ...b, managerId: req.user!.id }));
}));

router.delete("/nurses/:id", asyncH(async (req, res) => {
  res.json(await deleteNurse(Number(req.params.id), req.user!.id));
}));

// ── Doctor users ──────────────────────────────────────────────────────────────
// Strong password: ≥8 chars with at least one letter and one number.
const strongPassword = z.string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password is too long.")
  .regex(/[A-Za-z]/, "Password must contain at least one letter.")
  .regex(/[0-9]/, "Password must contain at least one number.");

router.post("/doctors", asyncH(async (req, res) => {
  const b = z.object({
    username: z.string().min(1, "Username is required.").max(40, "Username must be 40 characters or less."),
    password: strongPassword,
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long."),
    status:   z.enum(["active", "inactive"]).optional(),
    remarks:  z.string().max(500).optional(),
  }).parse(req.body);
  res.status(201).json(await createDoctor({ ...b, adminId: req.user!.id }));
}));

router.put("/doctors/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long.").optional(),
    password: strongPassword.optional(),
    status:   z.enum(["active", "inactive"]).optional(),
    remarks:  z.string().max(500).nullable().optional(),
  }).parse(req.body);
  res.json(await editDoctor({ userId: Number(req.params.id), ...b, adminId: req.user!.id }));
}));

router.delete("/doctors/:id", asyncH(async (req, res) => {
  res.json(await deleteDoctor(Number(req.params.id), req.user!.id));
}));

// ── bed details ───────────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));

router.post("/wards/:id/generate-beds", asyncH(async (req, res) => {
  const { bedNames, operationalStatus, bedType, acStatus } = z.object({
    bedNames:          z.array(z.string().min(1)).min(1).max(500),
    operationalStatus: z.boolean().optional(),
    bedType:           z.enum(["Census", "Non-Census"]).optional(),
    acStatus:          z.boolean().optional(),
  }).parse(req.body);
  const wardId = Number(req.params.id);
  const result = await generateBeds({ wardId, bedNames, operationalStatus, bedType, acStatus, userId: req.user!.id });
  const stationId = await stationIdForWard(wardId);
  emitUpdate("bed:update", { wardId }, stationId ? { stationId } : undefined);
  res.status(201).json(result);
}));

router.post("/wards/:id/beds", asyncH(async (req, res) => {
  const { bedName, operationalStatus, bedType, acStatus } = z.object({
    bedName:           z.string().min(1),
    operationalStatus: z.boolean().optional(),
    bedType:           z.enum(["Census", "Non-Census"]).optional(),
    acStatus:          z.boolean().optional(),
  }).parse(req.body);
  const wardId = Number(req.params.id);
  const result = await addSingleBed({ wardId, bedName, operationalStatus, bedType, acStatus, userId: req.user!.id });
  const stationId = await stationIdForWard(wardId);
  emitUpdate("bed:update", { wardId }, stationId ? { stationId } : undefined);
  res.status(201).json(result);
}));

router.patch("/beds/:id/name", asyncH(async (req, res) => {
  const { bedName } = z.object({ bedName: z.string().min(1) }).parse(req.body);
  res.json(await renameBed({ bedId: Number(req.params.id), newBedName: bedName, userId: req.user!.id }));
}));

router.patch("/beds/:id/master", asyncH(async (req, res) => {
  const { bedType, operationalStatus, acStatus } = z.object({
    bedType:           z.enum(["Census", "Non-Census"]).optional(),
    operationalStatus: z.boolean().optional(),
    acStatus:          z.boolean().optional(),
  }).parse(req.body);
  const bedId = Number(req.params.id);
  const stationId = await stationIdForBed(bedId);
  const result = await updateBedMaster({
    bedId, bedType, operationalStatus, acStatus, userId: req.user!.id,
  });
  emitUpdate("bed:update", { bedId }, stationId ? { stationId } : undefined);
  res.json(result);
}));

router.delete("/beds/:id", asyncH(async (req, res) => {
  const bedId = Number(req.params.id);
  const stationId = await stationIdForBed(bedId);
  const result = await deleteBed({ bedId, userId: req.user!.id });
  emitUpdate("bed:update", { bedId }, stationId ? { stationId } : undefined);
  res.json(result);
}));

// ── nursing stations ──────────────────────────────────────────────────────────

router.get("/nursing-stations", asyncH(async (_req, res) => {
  res.json({ stations: await listNursingStations() });
}));

router.post("/nursing-stations", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await createNursingStation({ name, managerId: req.user!.id });
  emitUpdate("bed:update", { stationId: result.id });
  res.status(201).json(result);
}));

router.put("/nursing-stations/:id", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const stationId = Number(req.params.id);
  const result = await editNursingStation({ stationId, name, managerId: req.user!.id });
  emitUpdate("bed:update", { stationId }, { stationId });
  res.json(result);
}));

router.put("/nursing-stations/:id/wards", asyncH(async (req, res) => {
  const { wardIds } = z.object({ wardIds: z.array(z.number().int()).min(0) }).parse(req.body);
  const stationId = Number(req.params.id);
  const result = await assignWardsToStation(stationId, wardIds, req.user!.id);
  emitUpdate("bed:update", { stationId }, { stationId });
  res.json(result);
}));

router.delete("/nursing-stations/:id", asyncH(async (req, res) => {
  const stationId = Number(req.params.id);
  const result = await deleteNursingStation(stationId, req.user!.id);
  emitUpdate("bed:update", { stationId }, { stationId });
  res.json(result);
}));

router.get("/stations/:id/coverage", asyncH(async (req, res) => {
  const stationId = Number(req.params.id);

  // Wards assigned to this station
  const wards = await db.prepare(
    "SELECT w.id, w.name FROM wards w WHERE w.station_id=? ORDER BY w.name"
  ).all<{ id: number; name: string }>(stationId);

  // Nurses in this station
  const nurses = await db.prepare(
    `SELECT id, name, username, employee_id, phone, email
     FROM users WHERE station_id=? AND role='NURSE' ORDER BY name`
  ).all<{ id: number; name: string; username: string; employee_id: string | null; phone: string | null; email: string | null }>(stationId);

  const nurseIds  = nurses.map(n => n.id);
  const wardIds   = wards.map(w => w.id);

  // Active assignments for station's nurses on station's wards
  const assignments = nurseIds.length > 0 && wardIds.length > 0
    ? await db.prepare(
        `SELECT nurse_id, ward_id, access_type, bed_names
         FROM nurse_access_assignments
         WHERE nurse_id = ANY(?) AND ward_id = ANY(?) AND status='active'`
      ).all<{ nurse_id: number; ward_id: number; access_type: string; bed_names: string }>(nurseIds, wardIds)
    : [];

  // Per-ward coverage
  const wardCoverage = await Promise.all(wards.map(async (w) => {
    const allBeds = (await db.prepare(
      "SELECT bed_name FROM bed_details WHERE ward_id=?"
    ).all<{ bed_name: string }>(w.id)).map(b => b.bed_name);

    const wardAssignments = assignments.filter(a => a.ward_id === w.id);
    const coveredSet = new Set<string>();
    let hasFullAccess = false;

    for (const a of wardAssignments) {
      if (a.access_type === "FULL") {
        hasFullAccess = true;
        for (const b of allBeds) coveredSet.add(b);
        break;
      } else {
        let beds: string[] = [];
        try { beds = JSON.parse(a.bed_names || "[]"); } catch { /* skip */ }
        for (const b of beds) coveredSet.add(b);
      }
    }

    const unassigned = allBeds.filter(b => !coveredSet.has(b));
    const total = allBeds.length;
    const assigned = total - unassigned.length;
    return {
      ward_id: w.id, ward_name: w.name,
      total_beds: total, assigned_beds: assigned,
      unassigned_beds: unassigned,
      has_full_access: hasFullAccess,
      coverage_pct: total > 0 ? Math.round((assigned / total) * 100) : 0,
    };
  }));

  // Nurse workload
  const nurseWorkload = nurses.map(n => {
    const myAssignments = assignments.filter(a => a.nurse_id === n.id);
    let bedCount = 0;
    for (const a of myAssignments) {
      if (a.access_type === "FULL") {
        const w = wardCoverage.find(wc => wc.ward_id === a.ward_id);
        bedCount += w?.total_beds ?? 0;
      } else {
        try { bedCount += JSON.parse(a.bed_names || "[]").length; } catch { /* skip */ }
      }
    }
    return {
      ...n,
      ward_count: myAssignments.length,
      bed_count: bedCount,
    };
  });

  res.json({ wards: wardCoverage, nurses: nurseWorkload });
}));

// ── Nurse Access Assignments ──────────────────────────────────────────────────

function parseQueryId(val: unknown, name: string): number | undefined {
  if (val === undefined) return undefined;
  if (Array.isArray(val)) throw new HttpError(400, `${name} must be a single value`);
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
}

router.get("/nurse-access", asyncH(async (req, res) => {
  const nurseId = parseQueryId(req.query.nurseId, "nurseId");
  const wardId  = parseQueryId(req.query.wardId, "wardId");
  const status  = req.query.status ? String(req.query.status) : undefined;
  res.json({ assignments: await listNurseAccess({ nurseId, wardId, status }) });
}));

router.post("/nurse-access", asyncH(async (req, res) => {
  const body = z.object({
    nurseId:    z.number().int().positive(),
    wardId:     z.number().int().positive(),
    accessType: z.enum(["FULL", "BEDS"]),
    bedNames:   z.array(z.string()).optional().default([]),
  }).parse(req.body);
  const result = await createNurseAccess({ ...body, managerId: req.user!.id });
  const stationId = await stationIdForNurse(body.nurseId);
  emitUpdate("bed:update", { nurseId: body.nurseId, wardId: body.wardId }, stationId ? { stationId } : undefined);
  res.status(201).json(result);
}));

router.put("/nurse-access/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({
    accessType: z.enum(["FULL", "BEDS"]).optional(),
    bedNames:   z.array(z.string()).optional(),
    status:     z.enum(["active", "inactive"]).optional(),
  }).parse(req.body);
  const row = await db.prepare("SELECT nurse_id, ward_id FROM nurse_access_assignments WHERE id=?")
    .get<{ nurse_id: number; ward_id: number }>(id);
  const result = await editNurseAccess({ id, ...body, managerId: req.user!.id });
  const stationId = row ? await stationIdForNurse(row.nurse_id) : undefined;
  emitUpdate("bed:update", { nurseId: row?.nurse_id, wardId: row?.ward_id }, stationId ? { stationId } : undefined);
  res.json(result);
}));

router.delete("/nurse-access/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.prepare("SELECT nurse_id, ward_id FROM nurse_access_assignments WHERE id=?")
    .get<{ nurse_id: number; ward_id: number }>(id);
  const result = await deleteNurseAccess(id, req.user!.id);
  const stationId = row ? await stationIdForNurse(row.nurse_id) : undefined;
  emitUpdate("bed:update", { nurseId: row?.nurse_id, wardId: row?.ward_id }, stationId ? { stationId } : undefined);
  res.json(result);
}));

// ── history ───────────────────────────────────────────────────────────────────

router.get("/history/dates", asyncH(async (_req, res) => {
  res.json({ dates: await availableDates() });
}));

router.get("/history/census-dates", asyncH(async (_req, res) => {
  res.json({ dates: await censusDates() });
}));

router.get("/history", asyncH(async (req, res) => {
  const date = String(req.query.date || "");
  // preBlockId is the current filter; floorId kept as a legacy alias
  const preBlockId = req.query.preBlockId ? Number(req.query.preBlockId)
                   : req.query.floorId    ? Number(req.query.floorId)
                   : undefined;
  if (!date) return res.json({ rounds: [], census: null });
  res.json({
    rounds: await historyForDate(date, preBlockId),
    census: await midnightCensusFor(date),
  });
}));

// ── PRE Blocks ────────────────────────────────────────────────────────────────

router.get("/pre-blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listPreBlocks() });
}));

router.get("/pre-blocks/:id", asyncH(async (req, res) => {
  res.json(await getPreBlock(Number(req.params.id)));
}));

router.post("/pre-blocks", asyncH(async (req, res) => {
  const { name, description, wardIds } = z.object({
    name:        z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    wardIds:     z.array(z.number().int()).min(1),
  }).parse(req.body);
  const result = await createPreBlock({ name, description, wardIds, managerId: req.user!.id });
  emitUpdate("bed:update", { preBlockId: result.id }, { pre: String(result.id) });
  res.status(201).json(result);
}));

router.put("/pre-blocks/:id", asyncH(async (req, res) => {
  const { name, description, wardIds } = z.object({
    name:        z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    wardIds:     z.array(z.number().int()).min(1).optional(),
  }).parse(req.body);
  const blockId = Number(req.params.id);
  const result = await editPreBlock({
    blockId, name,
    description: description ?? undefined, wardIds, managerId: req.user!.id,
  });
  emitUpdate("bed:update", { preBlockId: blockId }, { pre: String(blockId) });
  res.json(result);
}));

router.patch("/pre-blocks/:id/status", asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "inactive"]) }).parse(req.body);
  const blockId = Number(req.params.id);
  const result = await setPreBlockStatus(blockId, status, req.user!.id);
  emitUpdate("bed:update", { preBlockId: blockId, status }, { pre: String(blockId) });
  res.json(result);
}));

router.delete("/pre-blocks/:id", asyncH(async (req, res) => {
  const blockId = Number(req.params.id);
  const result = await deletePreBlock(blockId, req.user!.id);
  emitUpdate("bed:update", { preBlockId: blockId }, { pre: String(blockId) });
  res.json(result);
}));

// ── Doctor Blocks ───────────────────────────────────────────────────────────────

router.get("/doctor-blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listDoctorBlocks() });
}));

router.get("/doctor-blocks/:id", asyncH(async (req, res) => {
  res.json(await getDoctorBlock(Number(req.params.id)));
}));

router.post("/doctor-blocks", asyncH(async (req, res) => {
  const { name, description, wardIds, doctorIds } = z.object({
    name:        z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    wardIds:     z.array(z.number().int()).optional(),
    doctorIds:   z.array(z.number().int()).optional(),
  }).parse(req.body);
  const result = await createDoctorBlock({ name, description, wardIds, doctorIds, adminId: req.user!.id });
  emitUpdate("bed:update", { doctorBlockId: result.id }, { wardId: wardIds ?? [] });
  res.status(201).json(result);
}));

router.put("/doctor-blocks/:id", asyncH(async (req, res) => {
  const { name, description, wardIds, doctorIds } = z.object({
    name:        z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    wardIds:     z.array(z.number().int()).optional(),
    doctorIds:   z.array(z.number().int()).optional(),
  }).parse(req.body);
  const blockId = Number(req.params.id);
  // Ward rooms before AND after the edit must be notified (a ward could be removed).
  const before = await wardIdsForDoctorBlock(blockId);
  const result = await editDoctorBlock({
    blockId, name, description: description ?? undefined, wardIds, doctorIds, adminId: req.user!.id,
  });
  const after = await wardIdsForDoctorBlock(blockId);
  emitUpdate("bed:update", { doctorBlockId: blockId }, { wardId: [...new Set([...before, ...after])] });
  res.json(result);
}));

router.patch("/doctor-blocks/:id/status", asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "inactive"]) }).parse(req.body);
  const blockId = Number(req.params.id);
  const wardIds = await wardIdsForDoctorBlock(blockId);
  const result = await setDoctorBlockStatus(blockId, status, req.user!.id);
  emitUpdate("bed:update", { doctorBlockId: blockId, status }, { wardId: wardIds });
  res.json(result);
}));

router.delete("/doctor-blocks/:id", asyncH(async (req, res) => {
  const blockId = Number(req.params.id);
  const wardIds = await wardIdsForDoctorBlock(blockId);
  const result = await deleteDoctorBlock(blockId, req.user!.id);
  emitUpdate("bed:update", { doctorBlockId: blockId }, { wardId: wardIds });
  res.json(result);
}));

// ── Payer Types ───────────────────────────────────────────────────────────────
router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes() });
}));

router.post("/payer-types", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await createPayerType({ name, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: result.id });
  res.status(201).json(result);
}));

router.put("/payer-types/:id", asyncH(async (req, res) => {
  const { name, active } = z.object({
    name:   z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const result = await updatePayerType({ id, name, active, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: id });
  res.json(result);
}));

router.patch("/payer-types/:id/order", asyncH(async (req, res) => {
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  const id = Number(req.params.id);
  const result = await reorderPayerType({ id, direction, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: id });
  res.json(result);
}));

router.delete("/payer-types/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const result = await deletePayerType({ id, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: id });
  res.json(result);
}));

// ── Destinations ──────────────────────────────────────────────────────────────
router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations() });
}));

router.post("/destinations", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await createDestination({ name, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: result.id });
  res.status(201).json(result);
}));

router.put("/destinations/:id", asyncH(async (req, res) => {
  const { name, active } = z.object({
    name:   z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const result = await updateDestination({ id, name, active, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: id });
  res.json(result);
}));

router.patch("/destinations/:id/order", asyncH(async (req, res) => {
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  const id = Number(req.params.id);
  const result = await reorderDestination({ id, direction, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: id });
  res.json(result);
}));

router.delete("/destinations/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const result = await deleteDestination({ id, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: id });
  res.json(result);
}));

export default router;

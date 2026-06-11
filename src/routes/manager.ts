import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import {
  listBuildingBlocks, createBuildingBlock, editBuildingBlock, deleteBuildingBlock,
  listFloors, createFloor, editFloor, deleteFloor,
  createWard, editWard, deleteWard,
  createPre, editPre, setPreShift, deletePre,
  createNurse, editNurse, deleteNurse,
  listNursingStations, createNursingStation, editNursingStation, deleteNursingStation, assignWardsToStation,
  availableDates, historyForDate,
} from "../services/managerService.js";
import {
  listPreBlocks, getPreBlock, createPreBlock, editPreBlock,
  setPreBlockStatus, deletePreBlock,
} from "../services/preBlockService.js";
import {
  generateBeds, addSingleBed, listBeds, renameBed, deleteBed, updateBedMaster,
} from "../services/bedDetailService.js";

const router = Router();
router.use(authRequired, requireRole("MANAGER", "COO"));

// ── KPIs ──────────────────────────────────────────────────────────────────────

router.get("/kpis", asyncH(async (_req, res) => {
  const row = await db.prepare(`
    SELECT
      COUNT(*)::int                                                            AS total,
      COUNT(*) FILTER (WHERE w.bed_type = 'Census' OR w.bed_type IS NULL)::int AS census,
      COUNT(*) FILTER (WHERE w.bed_type = 'Non-Census')::int                  AS non_census,
      COUNT(*) FILTER (WHERE bd.operational_status)::int                      AS operational,
      COUNT(*) FILTER (WHERE NOT bd.operational_status)::int                  AS non_operational,
      COUNT(*) FILTER (WHERE bd.physical_status = 'VACANT'
                         AND bd.reservation_status = 'NONE'
                         AND bd.operational_status)::int                      AS vacant,
      COUNT(*) FILTER (WHERE bd.physical_status = 'VACANT'
                         AND bd.reservation_status = 'RESERVED')::int         AS vacant_reserved,
      COUNT(*) FILTER (WHERE bd.physical_status = 'OCCUPIED'
                         AND bd.reservation_status = 'NONE')::int             AS occupied,
      COUNT(*) FILTER (WHERE bd.physical_status = 'OCCUPIED'
                         AND bd.reservation_status = 'RESERVED')::int         AS occupied_reserved
    FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
  `).get<Record<string, number>>();
  const occupiedTotal = (row?.occupied ?? 0) + (row?.occupied_reserved ?? 0);
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
  res.status(201).json(await createBuildingBlock({ name, label, managerId: req.user!.id }));
}));

router.put("/building-blocks/:id", asyncH(async (req, res) => {
  const { name, label, sortOrder } = z.object({
    name:      z.string().optional(),
    label:     z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).parse(req.body);
  res.json(await editBuildingBlock({
    blockId: Number(req.params.id), name, label: label ?? undefined, sortOrder, managerId: req.user!.id,
  }));
}));

router.delete("/building-blocks/:id", asyncH(async (req, res) => {
  res.json(await deleteBuildingBlock(Number(req.params.id), req.user!.id));
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
  res.status(201).json(await createFloor({ name, buildingBlockId, managerId: req.user!.id }));
}));

router.put("/floors/:id", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
  res.json(await editFloor({ floorId: Number(req.params.id), name, managerId: req.user!.id }));
}));

router.delete("/floors/:id", asyncH(async (req, res) => {
  res.json(await deleteFloor(Number(req.params.id), req.user!.id));
}));

// ── wards ─────────────────────────────────────────────────────────────────────

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
    totalBeds:   z.number().int().min(0),
    stationId:   z.number().int().nullable().optional(),
    unitType:    z.string().optional(),
    roomType:    z.string().optional(),
    bedType:     z.enum(["Census", "Non-Census"]).optional(),
    operational: z.boolean().optional(),
  }).parse(req.body);
  res.status(201).json(await createWard({ ...b, managerId: req.user!.id }));
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
  res.json(await editWard({ wardId: Number(req.params.id), ...b, managerId: req.user!.id }));
}));

router.delete("/wards/:id", asyncH(async (req, res) => {
  res.json(await deleteWard(Number(req.params.id), req.user!.id));
}));

// ── users list ────────────────────────────────────────────────────────────────

router.get("/users", asyncH(async (_req, res) => {
  const users = await db.prepare(
    `SELECT u.id, u.username, u.role, u.name, u.shift,
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
    username:    z.string().min(1).max(40),
    password:    z.string().min(8).max(72),
    name:        z.string().min(1).max(80),
    preBlockId:  z.number().int().nullable().optional(),
    shift:       z.enum(["morning", "night"]).optional(),
  }).parse(req.body);
  res.status(201).json(await createPre({ ...b, managerId: req.user!.id }));
}));

router.put("/pre/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:        z.string().min(1).max(80).optional(),
    password:    z.string().min(8).max(72).optional(),
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

router.post("/nurses", asyncH(async (req, res) => {
  const b = z.object({
    username:  z.string().min(1).max(40),
    password:  z.string().min(8).max(72),
    name:      z.string().min(1).max(80),
    stationId: z.number().int(),
  }).parse(req.body);
  res.status(201).json(await createNurse({ ...b, managerId: req.user!.id }));
}));

router.put("/nurses/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:      z.string().min(1).max(80).optional(),
    password:  z.string().min(8).max(72).optional(),
    stationId: z.number().int().optional(),
  }).parse(req.body);
  res.json(await editNurse({ userId: Number(req.params.id), ...b, managerId: req.user!.id }));
}));

router.delete("/nurses/:id", asyncH(async (req, res) => {
  res.json(await deleteNurse(Number(req.params.id), req.user!.id));
}));

// ── bed details ───────────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));

router.post("/wards/:id/generate-beds", asyncH(async (req, res) => {
  const { bedNames } = z.object({
    bedNames: z.array(z.string().min(1)).min(1).max(500),
  }).parse(req.body);
  res.status(201).json(
    await generateBeds({ wardId: Number(req.params.id), bedNames, userId: req.user!.id })
  );
}));

router.post("/wards/:id/beds", asyncH(async (req, res) => {
  const { bedName } = z.object({ bedName: z.string().min(1) }).parse(req.body);
  res.status(201).json(
    await addSingleBed({ wardId: Number(req.params.id), bedName, userId: req.user!.id })
  );
}));

router.patch("/beds/:id/name", asyncH(async (req, res) => {
  const { bedName } = z.object({ bedName: z.string().min(1) }).parse(req.body);
  res.json(await renameBed({ bedId: Number(req.params.id), newBedName: bedName, userId: req.user!.id }));
}));

router.patch("/beds/:id/master", asyncH(async (req, res) => {
  const { bedType, operationalStatus } = z.object({
    bedType:           z.enum(["Census", "Non-Census"]).optional(),
    operationalStatus: z.boolean().optional(),
  }).parse(req.body);
  res.json(await updateBedMaster({
    bedId: Number(req.params.id), bedType, operationalStatus, userId: req.user!.id,
  }));
}));

router.delete("/beds/:id", asyncH(async (req, res) => {
  res.json(await deleteBed({ bedId: Number(req.params.id), userId: req.user!.id }));
}));

// ── nursing stations ──────────────────────────────────────────────────────────

router.get("/nursing-stations", asyncH(async (_req, res) => {
  res.json({ stations: await listNursingStations() });
}));

router.post("/nursing-stations", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  res.status(201).json(await createNursingStation({ name, managerId: req.user!.id }));
}));

router.put("/nursing-stations/:id", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  res.json(await editNursingStation({
    stationId: Number(req.params.id), name, managerId: req.user!.id,
  }));
}));

router.put("/nursing-stations/:id/wards", asyncH(async (req, res) => {
  const { wardIds } = z.object({ wardIds: z.array(z.number().int()).min(0) }).parse(req.body);
  res.json(await assignWardsToStation(Number(req.params.id), wardIds, req.user!.id));
}));

router.delete("/nursing-stations/:id", asyncH(async (req, res) => {
  res.json(await deleteNursingStation(Number(req.params.id), req.user!.id));
}));

// ── history ───────────────────────────────────────────────────────────────────

router.get("/history/dates", asyncH(async (_req, res) => {
  res.json({ dates: await availableDates() });
}));

router.get("/history", asyncH(async (req, res) => {
  const date    = String(req.query.date || "");
  const floorId = req.query.floorId ? Number(req.query.floorId) : undefined;
  if (!date) return res.json({ rounds: [] });
  res.json({ rounds: await historyForDate(date, floorId) });
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
  res.status(201).json(await createPreBlock({ name, description, wardIds, managerId: req.user!.id }));
}));

router.put("/pre-blocks/:id", asyncH(async (req, res) => {
  const { name, description, wardIds } = z.object({
    name:        z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    wardIds:     z.array(z.number().int()).min(1).optional(),
  }).parse(req.body);
  res.json(await editPreBlock({
    blockId: Number(req.params.id), name,
    description: description ?? undefined, wardIds, managerId: req.user!.id,
  }));
}));

router.patch("/pre-blocks/:id/status", asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "inactive"]) }).parse(req.body);
  res.json(await setPreBlockStatus(Number(req.params.id), status, req.user!.id));
}));

router.delete("/pre-blocks/:id", asyncH(async (req, res) => {
  res.json(await deletePreBlock(Number(req.params.id), req.user!.id));
}));

export default router;

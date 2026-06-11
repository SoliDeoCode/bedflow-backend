import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import { listBlocks, createBlock, editBlock, deleteBlock, createWard, editWard, deleteWard, createPre, editPre, setPreShift, deletePre, createNurse, editNurse, deleteNurse, availableDates, historyForDate, } from "../services/managerService.js";
import { generateBeds, addSingleBed, listBeds, renameBed, deleteBed, updateBedMaster, } from "../services/bedDetailService.js";
const router = Router();
router.use(authRequired, requireRole("MANAGER", "COO"));
// ── KPIs — live bed-master aggregates for the dashboard ───────────────────────
router.get("/kpis", asyncH(async (_req, res) => {
    const row = await db.prepare(`
    SELECT
      COUNT(*)::int                                                            AS total,
      COUNT(*) FILTER (WHERE bed_type = 'Census')::int                         AS census,
      COUNT(*) FILTER (WHERE bed_type <> 'Census')::int                        AS non_census,
      COUNT(*) FILTER (WHERE operational_status)::int                          AS operational,
      COUNT(*) FILTER (WHERE NOT operational_status)::int                      AS non_operational,
      COUNT(*) FILTER (WHERE physical_status = 'VACANT'
                         AND reservation_status = 'NONE'
                         AND operational_status)::int                          AS vacant,
      COUNT(*) FILTER (WHERE physical_status = 'VACANT'
                         AND reservation_status = 'RESERVED')::int             AS vacant_reserved,
      COUNT(*) FILTER (WHERE physical_status = 'OCCUPIED'
                         AND reservation_status = 'NONE')::int                 AS occupied,
      COUNT(*) FILTER (WHERE physical_status = 'OCCUPIED'
                         AND reservation_status = 'RESERVED')::int             AS occupied_reserved
    FROM bed_details
  `).get();
    const occupiedTotal = (row?.occupied ?? 0) + (row?.occupied_reserved ?? 0);
    const operational = row?.operational ?? 0;
    res.json({
        ...row,
        occupancy_pct: operational > 0 ? Math.round((occupiedTotal / operational) * 100) : 0,
        census_occupancy_pct: (row?.census ?? 0) > 0
            ? Math.round((occupiedTotal / (row.census)) * 100) : 0,
    });
}));
// ── blocks ────────────────────────────────────────────────────────────────────
router.get("/blocks", asyncH(async (_req, res) => {
    res.json({ blocks: await listBlocks() });
}));
router.post("/blocks", asyncH(async (req, res) => {
    const { name, label } = z.object({
        name: z.string().min(1),
        label: z.string().optional(),
    }).parse(req.body);
    res.status(201).json(await createBlock({ name, label, managerId: req.user.id }));
}));
router.put("/blocks/:id", asyncH(async (req, res) => {
    const { name, label, sortOrder } = z.object({
        name: z.string().optional(),
        label: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
    }).parse(req.body);
    res.json(await editBlock({ blockId: Number(req.params.id), name, label: label ?? undefined, sortOrder, managerId: req.user.id }));
}));
router.delete("/blocks/:id", asyncH(async (req, res) => {
    res.json(await deleteBlock(Number(req.params.id), req.user.id));
}));
// ── wards ─────────────────────────────────────────────────────────────────────
router.get("/wards", asyncH(async (_req, res) => {
    const wards = await db.prepare(`SELECT w.id, w.name, w.block_id, w.total_beds,
            w.nursing_station, w.unit_type, w.room_type,
            b.name AS block_name, b.label AS block_label,
            beds.vacant, beds.reserved, beds.occupied
     FROM wards w
     JOIN blocks b ON b.id = w.block_id
     JOIN beds   ON beds.ward_id = w.id
     ORDER BY b.sort_order, b.name, w.name`).all();
    res.json({ wards });
}));
router.post("/wards", asyncH(async (req, res) => {
    const b = z.object({
        name: z.string().min(1),
        blockId: z.number().int(),
        totalBeds: z.number().int().min(0),
        nursingStation: z.string().optional(),
        unitType: z.string().optional(),
        roomType: z.string().optional(),
    }).parse(req.body);
    res.status(201).json(await createWard({ ...b, managerId: req.user.id }));
}));
router.put("/wards/:id", asyncH(async (req, res) => {
    const b = z.object({
        name: z.string().optional(),
        totalBeds: z.number().int().min(0).optional(),
        blockId: z.number().int().optional(),
        nursingStation: z.string().nullable().optional(),
        unitType: z.string().nullable().optional(),
        roomType: z.string().nullable().optional(),
    }).parse(req.body);
    res.json(await editWard({ wardId: Number(req.params.id), ...b, managerId: req.user.id }));
}));
router.delete("/wards/:id", asyncH(async (req, res) => {
    res.json(await deleteWard(Number(req.params.id), req.user.id));
}));
// ── PRE users ─────────────────────────────────────────────────────────────────
router.get("/users", asyncH(async (_req, res) => {
    const users = await db.prepare(`SELECT u.id, u.username, u.role, u.name, u.shift,
            u.block_id, u.nursing_station,
            b.name AS block_name, b.label AS block_label
     FROM users u
     LEFT JOIN blocks b ON b.id = u.block_id
     ORDER BY u.role, u.username`).all();
    res.json({ users });
}));
router.post("/pre", asyncH(async (req, res) => {
    const b = z.object({
        username: z.string().min(1).max(40),
        password: z.string().min(8).max(72),
        name: z.string().min(1).max(80),
        blockId: z.number().int().nullable().optional(),
        shift: z.enum(["morning", "night"]).optional(),
    }).parse(req.body);
    res.status(201).json(await createPre({ ...b, managerId: req.user.id }));
}));
router.put("/pre/:id", asyncH(async (req, res) => {
    const b = z.object({
        name: z.string().min(1).max(80).optional(),
        password: z.string().min(8).max(72).optional(),
        shift: z.enum(["morning", "night"]).optional(),
        blockId: z.number().int().nullable().optional(),
    }).parse(req.body);
    res.json(await editPre({ userId: Number(req.params.id), ...b, managerId: req.user.id }));
}));
router.post("/pre/:id/shift", asyncH(async (req, res) => {
    const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
    res.json(await setPreShift(Number(req.params.id), shift, req.user.id));
}));
router.delete("/pre/:id", asyncH(async (req, res) => {
    res.json(await deletePre(Number(req.params.id), req.user.id));
}));
// ── Nurse In-Charge users ─────────────────────────────────────────────────────
router.post("/nurses", asyncH(async (req, res) => {
    const b = z.object({
        username: z.string().min(1).max(40),
        password: z.string().min(8).max(72),
        name: z.string().min(1).max(80),
        nursingStation: z.string().min(1),
    }).parse(req.body);
    res.status(201).json(await createNurse({ ...b, managerId: req.user.id }));
}));
router.put("/nurses/:id", asyncH(async (req, res) => {
    const b = z.object({
        name: z.string().min(1).max(80).optional(),
        password: z.string().min(8).max(72).optional(),
        nursingStation: z.string().min(1).optional(),
    }).parse(req.body);
    res.json(await editNurse({ userId: Number(req.params.id), ...b, managerId: req.user.id }));
}));
router.delete("/nurses/:id", asyncH(async (req, res) => {
    res.json(await deleteNurse(Number(req.params.id), req.user.id));
}));
// ── bed details ───────────────────────────────────────────────────────────────
router.get("/wards/:id/beds", asyncH(async (req, res) => {
    const wardId = Number(req.params.id);
    const physicalStatus = req.query.physical_status;
    const reservationStatus = req.query.reservation_status;
    res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));
router.post("/wards/:id/generate-beds", asyncH(async (req, res) => {
    const { bedNames } = z.object({
        bedNames: z.array(z.string().min(1)).min(1).max(500),
    }).parse(req.body);
    res.status(201).json(await generateBeds({ wardId: Number(req.params.id), bedNames, userId: req.user.id }));
}));
router.post("/wards/:id/beds", asyncH(async (req, res) => {
    const { bedName } = z.object({ bedName: z.string().min(1) }).parse(req.body);
    res.status(201).json(await addSingleBed({ wardId: Number(req.params.id), bedName, userId: req.user.id }));
}));
router.patch("/beds/:id/name", asyncH(async (req, res) => {
    const { bedName } = z.object({ bedName: z.string().min(1) }).parse(req.body);
    res.json(await renameBed({ bedId: Number(req.params.id), newBedName: bedName, userId: req.user.id }));
}));
router.patch("/beds/:id/master", asyncH(async (req, res) => {
    const { bedType, operationalStatus } = z.object({
        bedType: z.enum(["Census", "Non-Census"]).optional(),
        operationalStatus: z.boolean().optional(),
    }).parse(req.body);
    res.json(await updateBedMaster({ bedId: Number(req.params.id), bedType, operationalStatus, userId: req.user.id }));
}));
router.delete("/beds/:id", asyncH(async (req, res) => {
    res.json(await deleteBed({ bedId: Number(req.params.id), userId: req.user.id }));
}));
// ── nursing stations list ─────────────────────────────────────────────────────
router.get("/nursing-stations", asyncH(async (_req, res) => {
    const rows = await db.prepare("SELECT DISTINCT nursing_station FROM wards WHERE nursing_station IS NOT NULL ORDER BY nursing_station").all();
    res.json({ stations: rows.map((r) => r.nursing_station) });
}));
// ── history ───────────────────────────────────────────────────────────────────
router.get("/history/dates", asyncH(async (_req, res) => {
    res.json({ dates: await availableDates() });
}));
router.get("/history", asyncH(async (req, res) => {
    const date = String(req.query.date || "");
    const blockId = req.query.blockId ? Number(req.query.blockId) : undefined;
    if (!date)
        return res.json({ rounds: [] });
    res.json({ rounds: await historyForDate(date, blockId) });
}));
export default router;

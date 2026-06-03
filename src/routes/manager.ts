import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import {
  listBlocks, createBlock, editBlock, deleteBlock,
  createWard, editWard, deleteWard,
  createPre, editPre, setPreShift, deletePre,
  availableDates, historyForDate,
} from "../services/managerService.js";
import {
  generateBeds, addSingleBed, listBeds, renameBed, deleteBed,
} from "../services/bedDetailService.js";

const router = Router();
router.use(authRequired, requireRole("MANAGER", "COO"));

// ── blocks ────────────────────────────────────────────────────────────────────

router.get("/blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listBlocks() });
}));

router.post("/blocks", asyncH(async (req, res) => {
  const { name, label } = z.object({
    name:  z.string().min(1),
    label: z.string().optional(),
  }).parse(req.body);
  res.status(201).json(await createBlock({ name, label, managerId: req.user!.id }));
}));

router.put("/blocks/:id", asyncH(async (req, res) => {
  const { name, label, sortOrder } = z.object({
    name:      z.string().optional(),
    label:     z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).parse(req.body);
  res.json(await editBlock({ blockId: Number(req.params.id), name, label: label ?? undefined, sortOrder, managerId: req.user!.id }));
}));

router.delete("/blocks/:id", asyncH(async (req, res) => {
  res.json(await deleteBlock(Number(req.params.id), req.user!.id));
}));

// ── wards ─────────────────────────────────────────────────────────────────────

router.get("/wards", asyncH(async (_req, res) => {
  const wards = await db.prepare(
    `SELECT w.id, w.name, w.block_id, w.total_beds,
            b.name AS block_name, b.label AS block_label,
            beds.vacant, beds.reserved, beds.occupied
     FROM wards w
     JOIN blocks b ON b.id = w.block_id
     JOIN beds   ON beds.ward_id = w.id
     ORDER BY b.sort_order, b.name, w.name`
  ).all();
  res.json({ wards });
}));

router.post("/wards", asyncH(async (req, res) => {
  const { name, blockId, totalBeds } = z.object({
    name:      z.string().min(1),
    blockId:   z.number().int(),
    totalBeds: z.number().int().min(0),
  }).parse(req.body);
  res.status(201).json(await createWard({ name, blockId, totalBeds, managerId: req.user!.id }));
}));

router.put("/wards/:id", asyncH(async (req, res) => {
  const { name, totalBeds, blockId } = z.object({
    name:      z.string().optional(),
    totalBeds: z.number().int().min(0).optional(),
    blockId:   z.number().int().optional(),
  }).parse(req.body);
  res.json(await editWard({ wardId: Number(req.params.id), name, totalBeds, blockId, managerId: req.user!.id }));
}));

router.delete("/wards/:id", asyncH(async (req, res) => {
  res.json(await deleteWard(Number(req.params.id), req.user!.id));
}));

// ── PRE users ─────────────────────────────────────────────────────────────────

router.get("/users", asyncH(async (_req, res) => {
  const users = await db.prepare(
    `SELECT u.id, u.username, u.role, u.name, u.shift,
            u.block_id, b.name AS block_name, b.label AS block_label
     FROM users u
     LEFT JOIN blocks b ON b.id = u.block_id
     ORDER BY u.role, u.username`
  ).all();
  res.json({ users });
}));

router.post("/pre", asyncH(async (req, res) => {
  const b = z.object({
    username: z.string().min(1).max(40),
    password: z.string().min(8).max(72),
    name:     z.string().min(1).max(80),
    blockId:  z.number().int().nullable().optional(),
    shift:    z.enum(["morning", "night"]).optional(),
  }).parse(req.body);
  res.status(201).json(await createPre({ ...b, managerId: req.user!.id }));
}));

router.put("/pre/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:     z.string().min(1).max(80).optional(),
    password: z.string().min(8).max(72).optional(),
    shift:    z.enum(["morning", "night"]).optional(),
    blockId:  z.number().int().nullable().optional(),
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

// ── bed details ───────────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));

router.post("/wards/:id/generate-beds", asyncH(async (req, res) => {
  const { startNumber, count } = z.object({
    startNumber: z.number().int().min(1),
    count:       z.number().int().min(1).max(500),
  }).parse(req.body);
  res.status(201).json(
    await generateBeds({ wardId: Number(req.params.id), startNumber, count, userId: req.user!.id })
  );
}));

router.post("/wards/:id/beds", asyncH(async (req, res) => {
  const { bedNumber } = z.object({ bedNumber: z.string().min(1) }).parse(req.body);
  res.status(201).json(
    await addSingleBed({ wardId: Number(req.params.id), bedNumber, userId: req.user!.id })
  );
}));

router.patch("/beds/:id/number", asyncH(async (req, res) => {
  const { bedNumber } = z.object({ bedNumber: z.string().min(1) }).parse(req.body);
  res.json(await renameBed({ bedId: Number(req.params.id), newBedNumber: bedNumber, userId: req.user!.id }));
}));

router.delete("/beds/:id", asyncH(async (req, res) => {
  res.json(await deleteBed({ bedId: Number(req.params.id), userId: req.user!.id }));
}));

// ── history ───────────────────────────────────────────────────────────────────

router.get("/history/dates", asyncH(async (_req, res) => {
  res.json({ dates: await availableDates() });
}));

router.get("/history", asyncH(async (req, res) => {
  const date    = String(req.query.date || "");
  const blockId = req.query.blockId ? Number(req.query.blockId) : undefined;
  if (!date) return res.json({ rounds: [] });
  res.json({ rounds: await historyForDate(date, blockId) });
}));

export default router;

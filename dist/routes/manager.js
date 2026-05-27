import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import { createPre, editPre, setPreShift, deletePre, setPreFloor, createWard, editWard, deleteWard, availableDates, historyForDate, } from "../services/managerService.js";
const router = Router();
router.use(authRequired, requireRole("MANAGER", "COO"));
// ---- listing ----
router.get("/wards", asyncH(async (_req, res) => {
    const wards = db.prepare(`SELECT w.id, w.name, w.pre_code, w.total_beds,
            b.vacant, b.reserved, b.occupied, f.name AS floor
     FROM wards w JOIN beds b ON b.ward_id = w.id
     LEFT JOIN floors f ON f.id = w.floor_id ORDER BY w.pre_code, w.name`).all();
    res.json({ wards });
}));
router.get("/users", asyncH(async (_req, res) => {
    const users = db.prepare(`SELECT u.id, u.username, u.role, u.name, u.shift, a.pre_code AS pre
     FROM users u LEFT JOIN pre_assignments a ON a.user_id = u.id
     ORDER BY u.role, u.username`).all();
    res.json({ users });
}));
router.get("/floors", asyncH(async (_req, res) => {
    res.json({ floors: db.prepare("SELECT id, name FROM floors ORDER BY name").all() });
}));
// ---- PRE lifecycle ----
router.post("/pre", asyncH(async (req, res) => {
    const b = z.object({
        username: z.string().min(1), password: z.string().min(3), name: z.string().min(1),
        preCode: z.string().min(1), floor: z.string().optional(),
        shift: z.enum(["morning", "night"]).optional(),
    }).parse(req.body);
    res.json(createPre({ ...b, managerId: req.user.id }));
}));
router.put("/pre/:id", asyncH(async (req, res) => {
    const b = z.object({
        name: z.string().optional(), password: z.string().min(3).optional(),
        shift: z.enum(["morning", "night"]).optional(), preCode: z.string().optional(),
    }).parse(req.body);
    res.json(editPre({ userId: Number(req.params.id), ...b, managerId: req.user.id }));
}));
router.post("/pre/:id/shift", asyncH(async (req, res) => {
    const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
    res.json(setPreShift(Number(req.params.id), shift, req.user.id));
}));
// FIX: soft-guarded PRE delete
router.delete("/pre/:id", asyncH(async (req, res) => {
    res.json(deletePre(Number(req.params.id), req.user.id));
}));
// FIX: reassign ALL wards of a PRE to a different floor atomically
router.put("/pre/:code/floor", asyncH(async (req, res) => {
    const { floor } = z.object({ floor: z.string().nullable() }).parse(req.body);
    res.json(setPreFloor(req.params.code, floor, req.user.id));
}));
// ---- ward / bed management ----
router.post("/wards", asyncH(async (req, res) => {
    const b = z.object({
        name: z.string().min(1), preCode: z.string().min(1),
        totalBeds: z.number().int().min(0), floor: z.string().optional(),
    }).parse(req.body);
    res.json(createWard({ ...b, managerId: req.user.id }));
}));
router.put("/wards/:id", asyncH(async (req, res) => {
    const b = z.object({
        totalBeds: z.number().int().min(0).optional(), floor: z.string().optional(),
    }).parse(req.body);
    res.json(editWard({ wardId: Number(req.params.id), ...b, managerId: req.user.id }));
}));
router.delete("/wards/:id", asyncH(async (req, res) => {
    res.json(deleteWard(Number(req.params.id), req.user.id));
}));
router.post("/assign", asyncH(async (req, res) => {
    const { userId, preCode } = z.object({ userId: z.number().int(), preCode: z.string().min(1) }).parse(req.body);
    db.prepare("INSERT OR IGNORE INTO pre_assignments (user_id, pre_code, created_at) VALUES (?,?,?)")
        .run(userId, preCode, Date.now());
    res.json({ ok: true });
}));
// ---- history (date dropdown) ----
router.get("/history/dates", asyncH(async (_req, res) => {
    res.json({ dates: availableDates() });
}));
router.get("/history", asyncH(async (req, res) => {
    const date = String(req.query.date || "");
    const pre = req.query.pre ? String(req.query.pre) : undefined;
    if (!date)
        return res.json({ rounds: [] });
    res.json({ rounds: historyForDate(date, pre) });
}));
export default router;

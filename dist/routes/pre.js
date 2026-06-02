import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { wardsForBlock, summarize, updateWard } from "../services/bedService.js";
import { alarmState, setShift, userShift, submitRound } from "../services/roundService.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";
const router = Router();
router.use(authRequired, requireRole("PRE"));
/** Return the block_id + block_name for the authenticated PRE user. */
async function myBlock(req) {
    const row = await db.prepare(`SELECT u.block_id, b.name AS block_name
     FROM users u
     JOIN blocks b ON b.id = u.block_id
     WHERE u.id = ?`).get(req.user.id);
    if (!row)
        throw new HttpError(400, "No block assigned to your account");
    return row;
}
router.get("/me", asyncH(async (req, res) => {
    const { block_id, block_name } = await myBlock(req);
    const wards = await wardsForBlock(block_id);
    const shift = await userShift(req.user.id);
    res.json({
        block: block_name,
        pre: block_name, // legacy alias for PREApp.jsx that reads data.pre
        floor: block_name, // legacy alias for PREApp.jsx that reads data.floor
        wards,
        summary: summarize(wards),
        alarm: await alarmState(block_name, shift),
        label: `Block ${block_name}`,
    });
}));
router.post("/shift", asyncH(async (req, res) => {
    const { shift } = z.object({ shift: z.enum(["morning", "night"]) }).parse(req.body);
    await setShift(req.user.id, shift);
    res.json({ ok: true, shift });
}));
router.post("/ward", asyncH(async (req, res) => {
    const { block_id } = await myBlock(req);
    const { wardId, vacant, reserved } = z.object({
        wardId: z.number().int(), vacant: z.number().int().min(0), reserved: z.number().int().min(0),
    }).parse(req.body);
    // Verify the ward belongs to this user's block
    const owns = await db.prepare("SELECT 1 FROM wards WHERE id=? AND block_id=?").get(wardId, block_id);
    if (!owns)
        throw new HttpError(403, "Ward not assigned to your block");
    const result = await updateWard(wardId, vacant, reserved, req.user.id);
    const blockName = (await db.prepare("SELECT name FROM blocks WHERE id=?")
        .get(block_id))?.name ?? "";
    emitUpdate("bed:update", { block: blockName, ...result }, blockName);
    res.json({ ok: true, ...result });
}));
router.post("/submit", asyncH(async (req, res) => {
    const { block_id, block_name } = await myBlock(req);
    const result = await submitRound(block_id, req.user.id);
    emitUpdate("round:submit", { block: block_name }, block_name);
    res.json(result);
}));
// ── bed-level tracking (PRE only) ─────────────────────────────────────────────
router.get("/wards/:id/beds", asyncH(async (req, res) => {
    const { block_id } = await myBlock(req);
    const wardId = Number(req.params.id);
    if (!await db.prepare("SELECT 1 FROM wards WHERE id=? AND block_id=?").get(wardId, block_id))
        throw new HttpError(403, "Ward not in your block");
    const status = req.query.status;
    res.json({ beds: await listBeds(wardId, status) });
}));
router.patch("/beds/:id/status", asyncH(async (req, res) => {
    const { block_id, block_name } = await myBlock(req);
    const bedId = Number(req.params.id);
    const { status } = z.object({
        status: z.enum(["VACANT", "RESERVED", "OCCUPIED"]),
    }).parse(req.body);
    const owns = await db.prepare(`SELECT bd.id FROM bed_details bd
     JOIN wards w ON w.id = bd.ward_id
     WHERE bd.id = ? AND w.block_id = ?`).get(bedId, block_id);
    if (!owns)
        throw new HttpError(403, "Bed not in your block");
    const result = await updateBedStatus({ bedId, newStatus: status, userId: req.user.id });
    emitUpdate("bed:update", { block: block_name }, block_name);
    res.json(result);
}));
export default router;

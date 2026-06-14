import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { z } from "zod";
import { orgOverview, allWardsLive } from "../services/bedService.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, startOfDayIST, PRE_INTERVAL_MIN, SHIFTS, currentRound, inShift, roundKey } from "../config/domain.js";
import { recentAudit } from "../services/auditService.js";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
const router = Router();
router.use(authRequired, requireRole("COO", "MANAGER"));
router.get("/overview", asyncH(async (_req, res) => {
    const base = await orgOverview();
    const mins = minsNow();
    const today = todayStr();
    const allPres = base.floors.flatMap(g => g.pres);
    let alarmByFloorId = new Map();
    if (allPres.length > 0) {
        const floorIds = allPres.map(p => p.floor_id);
        // Batch: ward counts per pre_block (floor_id used as pre_block_id for legacy compat)
        const wardCountRows = await db.prepare(`SELECT pre_block_id, COUNT(*) AS n FROM pre_block_wards
       WHERE pre_block_id = ANY(?) GROUP BY pre_block_id`).all(floorIds);
        const wardCountByBlock = new Map(wardCountRows.map(r => [Number(r.pre_block_id), Number(r.n)]));
        // Compute current round keys for all floors (pure JS, no DB)
        const keyMeta = new Map();
        const allKeys = [];
        for (const p of allPres) {
            const shift = p.assignedUser?.shift || "morning";
            const round = currentRound(shift, mins);
            const key = roundKey(`pb${p.floor_id}`, shift, today, round.startMin);
            keyMeta.set(p.floor_id, { shift, round, key });
            allKeys.push(key);
        }
        // Batch: which round keys have been submitted
        const submittedRows = await db.prepare(`SELECT round_key FROM pre_rounds WHERE round_key = ANY(?)`).all(allKeys);
        const submittedKeys = new Set(submittedRows.map(r => r.round_key));
        for (const p of allPres) {
            const { shift, round, key } = keyMeta.get(p.floor_id);
            const onDuty = inShift(shift, mins);
            const hasWards = (wardCountByBlock.get(p.floor_id) ?? 0) > 0;
            const submitted = submittedKeys.has(key);
            alarmByFloorId.set(p.floor_id, {
                shift, onDuty, round, key, submitted, hasWards,
                alarmActive: onDuty && hasWards && !submitted,
            });
        }
    }
    const floors = base.floors.map(group => ({
        ...group,
        pres: group.pres.map(p => ({ ...p, alarm: alarmByFloorId.get(p.floor_id) ?? null })),
    }));
    const dueReminder = COO_REMINDERS.find(r => {
        const m = hmToMin(r);
        return mins >= m && mins < m + 30;
    }) || null;
    res.json({ floors, totals: base.totals, dueReminder });
}));
router.get("/live-wards", asyncH(async (_req, res) => {
    res.json(await allWardsLive());
}));
router.get("/audit", asyncH(async (_req, res) => {
    res.json({ logs: await recentAudit(150) });
}));
// Rounds are submitted per PRE Block — compliance is scored per active PRE
// Block with wards, using the assigned PRE user's shift.
router.get("/compliance", asyncH(async (_req, res) => {
    const today = todayStr();
    const mins = minsNow();
    const dayStart = startOfDayIST();
    const blocks = await db.prepare(`SELECT pb.id, pb.name
     FROM pre_blocks pb
     WHERE pb.status = 'active'
       AND EXISTS (SELECT 1 FROM pre_block_wards pbw WHERE pbw.pre_block_id = pb.id)
     ORDER BY pb.name`).all();
    if (blocks.length === 0)
        return res.json({ date: today, compliance: [] });
    const blockIds = blocks.map(b => b.id);
    // Batch: one PRE user per block
    const userRows = await db.prepare(`SELECT DISTINCT ON (pre_block_id) id, shift, name, pre_block_id
     FROM users WHERE role = 'PRE' AND pre_block_id = ANY(?) ORDER BY pre_block_id, id`).all(blockIds);
    const userByBlock = new Map(userRows.map(u => [Number(u.pre_block_id), u]));
    // Batch: submitted round counts per block since start of day
    const countRows = await db.prepare(`SELECT pre_block_id, COUNT(*) AS c
     FROM pre_rounds WHERE pre_block_id = ANY(?) AND submitted_at >= ? GROUP BY pre_block_id`).all(blockIds, dayStart);
    const countByBlock = new Map(countRows.map(r => [Number(r.pre_block_id), Number(r.c)]));
    const rows = blocks.map(block => {
        const user = userByBlock.get(block.id);
        const shift = user?.shift || "morning";
        const s = SHIFTS[shift];
        const start = hmToMin(s.start);
        let elapsed = mins - start;
        if (elapsed < 0)
            elapsed += 1440; // cross-midnight shift
        const expected = Math.max(0, Math.min(Math.floor(elapsed / PRE_INTERVAL_MIN) + 1, Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)));
        const submitted = countByBlock.get(block.id) ?? 0;
        const score = expected > 0
            ? Math.round((Math.min(submitted, expected) / expected) * 100)
            : 100;
        return {
            preBlockId: block.id,
            floorId: block.id,
            floor: block.name, block: block.name,
            name: user?.name ?? block.name,
            hasPre: !!user,
            shift, expected, submitted, score,
        };
    });
    res.json({ date: today, compliance: rows });
}));
// ── PRE activity — all blocks with ward counts, rounds today, compliance ──────
router.get("/pre-activity", asyncH(async (_req, res) => {
    const today = startOfDayIST();
    const mins = minsNow();
    const blocks = await db.prepare(`SELECT pb.id, pb.name, pb.status FROM pre_blocks pb ORDER BY pb.name`).all();
    if (blocks.length === 0)
        return res.json({ blocks: [] });
    const blockIds = blocks.map(b => b.id);
    const userRows = await db.prepare(`SELECT DISTINCT ON (pre_block_id) id, name, shift, pre_block_id
     FROM users WHERE role = 'PRE' AND pre_block_id = ANY(?) ORDER BY pre_block_id, id`).all(blockIds);
    const userByBlock = new Map(userRows.map(u => [Number(u.pre_block_id), u]));
    const wardRows = await db.prepare(`SELECT pbw.pre_block_id, w.id, w.name AS ward, w.total_beds AS total,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     WHERE pbw.pre_block_id = ANY(?) AND w.operational = true
     ORDER BY pbw.pre_block_id, w.name`).all(blockIds);
    const wardsByBlock = new Map();
    for (const w of wardRows) {
        const k = Number(w.pre_block_id);
        if (!wardsByBlock.has(k))
            wardsByBlock.set(k, []);
        wardsByBlock.get(k).push(w);
    }
    const roundRows = await db.prepare(`SELECT pre_block_id, COUNT(*) AS c, MAX(submitted_at) AS last_at
     FROM pre_rounds WHERE pre_block_id = ANY(?) AND submitted_at >= ?
     GROUP BY pre_block_id`).all(blockIds, today);
    const roundsByBlock = new Map(roundRows.map(r => [Number(r.pre_block_id), r]));
    const result = blocks.map(block => {
        const user = userByBlock.get(block.id);
        const shift = user?.shift || "morning";
        const s = SHIFTS[shift];
        const start = hmToMin(s.start);
        let elapsed = mins - start;
        if (elapsed < 0)
            elapsed = 0;
        const expected = Math.max(0, Math.min(Math.floor(elapsed / PRE_INTERVAL_MIN) + 1, Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)));
        const rounds = roundsByBlock.get(block.id);
        const submitted = Number(rounds?.c ?? 0);
        const score = expected > 0 ? Math.round((Math.min(submitted, expected) / expected) * 100) : 100;
        return {
            id: block.id, name: block.name, status: block.status,
            assignedUser: user ? { id: user.id, name: user.name, shift: user.shift } : null,
            wards: wardsByBlock.get(block.id) ?? [],
            roundsToday: submitted,
            lastSubmittedAt: rounds?.last_at ?? null,
            compliance: { expected, submitted, score },
        };
    });
    res.json({ blocks: result });
}));
// ── Nurse activity — all stations with nurses, assigned wards, last updates ──
router.get("/nurse-activity", asyncH(async (_req, res) => {
    const stations = await db.prepare(`SELECT id, name FROM nursing_stations ORDER BY name`).all();
    const nurses = await db.prepare(`SELECT id, name, username, station_id FROM users WHERE role = 'NURSE' ORDER BY name`).all();
    const wards = await db.prepare(`SELECT w.id, w.name AS ward, w.total_beds AS total, w.station_id,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved,
            b.updated_at AS "updatedAt", b.updated_by
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.operational = true ORDER BY w.name`).all();
    // Resolve updater names
    const updaterIds = [...new Set(wards.map(w => w.updated_by).filter((x) => x != null))];
    let nameMap = new Map();
    if (updaterIds.length > 0) {
        const uRows = await db.prepare(`SELECT id, name, role FROM users WHERE id = ANY(?)`).all(updaterIds);
        for (const u of uRows)
            nameMap.set(u.id, `${u.name} (${u.role})`);
    }
    const mapWard = (w) => ({
        id: w.id, ward: w.ward, total: w.total,
        vacant: w.vacant, reserved: w.reserved,
        occupied: w.occupied, occupied_reserved: w.occupied_reserved,
        updatedAt: w.updatedAt,
        updatedBy: w.updated_by ? (nameMap.get(w.updated_by) ?? null) : null,
    });
    const nursesByStation = new Map();
    const wardsByStation = new Map();
    for (const n of nurses) {
        const k = n.station_id;
        if (!nursesByStation.has(k))
            nursesByStation.set(k, []);
        nursesByStation.get(k).push(n);
    }
    for (const w of wards) {
        const k = w.station_id;
        if (!wardsByStation.has(k))
            wardsByStation.set(k, []);
        wardsByStation.get(k).push(w);
    }
    const stationData = stations.map(s => ({
        id: s.id, name: s.name,
        nurses: (nursesByStation.get(s.id) ?? []).map(n => ({ id: n.id, name: n.name, username: n.username })),
        wards: (wardsByStation.get(s.id) ?? []).map(mapWard),
    }));
    res.json({
        stations: stationData,
        unassignedNurses: (nursesByStation.get(null) ?? []).map(n => ({ id: n.id, name: n.name, username: n.username })),
        unassignedWards: (wardsByStation.get(null) ?? []).map(mapWard),
    });
}));
router.get("/snapshots", asyncH(async (_req, res) => {
    const rows = await db.prepare("SELECT ts,total,vacant,reserved,occupied FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48").all();
    res.json({ snapshots: rows.reverse() });
}));
function parseView(v, currentUserId) {
    return {
        id: v.id, name: v.name,
        selected_wards: JSON.parse(v.selected_wards),
        is_shared: !!v.is_shared,
        is_system: !!v.is_system,
        mine: v.created_by === currentUserId,
        created_at: v.created_at, updated_at: v.updated_at,
    };
}
router.get("/views", asyncH(async (req, res) => {
    const userId = req.user.id;
    const rows = await db.prepare(`
    SELECT id, name, created_by, selected_wards, is_shared, is_system, created_at, updated_at
    FROM saved_views
    WHERE is_system = 1 OR is_shared = 1 OR created_by = ?
    ORDER BY is_system DESC, name ASC
  `).all(userId);
    res.json({ views: rows.map(r => parseView(r, userId)) });
}));
router.post("/views", asyncH(async (req, res) => {
    const { name, selected_wards, is_shared } = z.object({
        name: z.string().min(1).max(60),
        selected_wards: z.array(z.string()),
        is_shared: z.boolean().optional().default(false),
    }).parse(req.body);
    const now = Date.now();
    const r = await db.prepare(`INSERT INTO saved_views (name, created_by, selected_wards, is_shared, is_system, created_at, updated_at)
     VALUES (?,?,?,?,0,?,?) RETURNING id`).run(name, req.user.id, JSON.stringify(selected_wards), is_shared ? 1 : 0, now, now);
    res.status(201).json({ ok: true, id: r.lastInsertRowid });
}));
router.put("/views/:id", asyncH(async (req, res) => {
    const id = Number(req.params.id);
    const view = await db.prepare("SELECT * FROM saved_views WHERE id=?").get(id);
    if (!view)
        throw new HttpError(404, "View not found");
    if (view.is_system)
        throw new HttpError(403, "System views cannot be edited");
    if (view.created_by !== req.user.id)
        throw new HttpError(403, "Not your view");
    const { name, selected_wards, is_shared } = z.object({
        name: z.string().min(1).max(60),
        selected_wards: z.array(z.string()),
        is_shared: z.boolean(),
    }).parse(req.body);
    await db.prepare("UPDATE saved_views SET name=?, selected_wards=?, is_shared=?, updated_at=? WHERE id=?").run(name, JSON.stringify(selected_wards), is_shared ? 1 : 0, Date.now(), id);
    res.json({ ok: true });
}));
router.delete("/views/:id", asyncH(async (req, res) => {
    const id = Number(req.params.id);
    const view = await db.prepare("SELECT * FROM saved_views WHERE id=?").get(id);
    if (!view)
        throw new HttpError(404, "View not found");
    if (view.is_system)
        throw new HttpError(403, "System views cannot be deleted");
    if (view.created_by !== req.user.id)
        throw new HttpError(403, "Not your view");
    await db.prepare("DELETE FROM saved_views WHERE id=?").run(id);
    res.json({ ok: true });
}));
export default router;

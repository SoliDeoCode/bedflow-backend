import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { orgOverview } from "../services/bedService.js";
import { alarmState, userShift } from "../services/roundService.js";
import { recentAudit } from "../services/auditService.js";
import { db } from "../db/index.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, startOfDayIST, PRE_INTERVAL_MIN, SHIFTS } from "../config/domain.js";
const router = Router();
router.use(authRequired, requireRole("COO", "MANAGER"));
router.get("/overview", asyncH(async (_req, res) => {
    const base = orgOverview();
    const floors = base.floors.map((f) => ({
        ...f,
        pres: f.pres.map((p) => {
            // Find the PRE user assigned to this block for alarm state
            const block = db.prepare("SELECT id FROM blocks WHERE name_key=?")
                .get(p.pre.toUpperCase().trim());
            const uid = block
                ? db.prepare("SELECT id FROM users WHERE block_id=? AND role='PRE'")
                    .get(block.id)
                : null;
            const shift = uid ? userShift(uid.id) : "morning";
            return { ...p, alarm: alarmState(p.pre, shift) };
        }),
    }));
    const mins = minsNow();
    const dueReminder = COO_REMINDERS.find(r => {
        const m = hmToMin(r);
        return mins >= m && mins < m + 30;
    }) || null;
    res.json({ floors, totals: base.totals, dueReminder });
}));
router.get("/audit", asyncH(async (_req, res) => {
    res.json({ logs: recentAudit(150) });
}));
router.get("/compliance", asyncH(async (_req, res) => {
    const today = todayStr();
    const mins = minsNow();
    // All blocks that have at least one ward
    const blocks = db.prepare(`SELECT b.id, b.name,
            u.id AS user_id, u.shift, u.name AS user_name
     FROM blocks b
     LEFT JOIN users u ON u.block_id = b.id AND u.role = 'PRE'
     WHERE EXISTS (SELECT 1 FROM wards w WHERE w.block_id = b.id)
     ORDER BY b.sort_order, b.name`).all();
    const rows = blocks.map(block => {
        const shift = block.shift || "morning";
        const s = SHIFTS[shift];
        const start = hmToMin(s.start);
        let elapsed = mins - start;
        if (elapsed < 0)
            elapsed = 0;
        const expected = Math.max(0, Math.min(Math.floor(elapsed / PRE_INTERVAL_MIN) + 1, Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)));
        const submitted = db.prepare("SELECT COUNT(*) AS c FROM pre_rounds WHERE block_id=? AND submitted_at>=?").get(block.id, startOfDayIST())?.c ?? 0;
        const score = expected > 0
            ? Math.round((Math.min(submitted, expected) / expected) * 100)
            : 100;
        return { blockId: block.id, block: block.name, name: block.user_name ?? block.name,
            shift, expected, submitted, score };
    });
    res.json({ date: today, compliance: rows });
}));
router.get("/snapshots", asyncH(async (_req, res) => {
    const rows = db.prepare("SELECT ts,total,vacant,reserved,occupied FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48").all();
    res.json({ snapshots: rows.reverse() });
}));
export default router;

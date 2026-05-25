import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { orgOverview } from "../services/bedService.js";
import { alarmState, userShift } from "../services/roundService.js";
import { recentAudit } from "../services/auditService.js";
import { db } from "../db/index.js";
import { COO_REMINDERS, hmToMin, minsNow } from "../config/domain.js";
const router = Router();
router.use(authRequired, requireRole("COO", "MANAGER"));
router.get("/overview", asyncH(async (_req, res) => {
    const base = orgOverview();
    // attach alarm state per PRE for compliance display
    const floors = base.floors.map((f) => ({
        ...f,
        pres: f.pres.map((p) => {
            const uid = db.prepare("SELECT u.id FROM users u JOIN pre_assignments a ON a.user_id=u.id WHERE a.pre_code=?").get(p.pre);
            const shift = uid ? userShift(uid.id) : "morning";
            return { ...p, alarm: alarmState(p.pre, shift) };
        }),
    }));
    const mins = minsNow();
    const dueReminder = COO_REMINDERS.find((r) => { const m = hmToMin(r); return mins >= m && mins < m + 30; }) || null;
    res.json({ floors, totals: base.totals, dueReminder });
}));
router.get("/audit", asyncH(async (_req, res) => {
    res.json({ logs: recentAudit(150) });
}));
// Compliance scoring: for today, how many rounds each PRE submitted vs expected.
router.get("/compliance", asyncH(async (_req, res) => {
    const { todayStr, SHIFTS, hmToMin, minsNow, PRE_INTERVAL_MIN, WARDS } = await import("../config/domain.js");
    const today = todayStr();
    const mins = minsNow();
    const rows = Object.keys(WARDS).filter((pre) => WARDS[pre].length > 0).map((pre) => {
        const uid = db.prepare("SELECT u.id, u.shift, u.name FROM users u JOIN pre_assignments a ON a.user_id=u.id WHERE a.pre_code=?").get(pre);
        const shift = uid?.shift || "morning";
        const s = SHIFTS[shift];
        const start = hmToMin(s.start);
        // expected rounds so far today = how many 2-hour slots have elapsed in-shift
        let elapsed = mins - start;
        if (elapsed < 0)
            elapsed = 0;
        const expected = Math.max(0, Math.min(Math.floor(elapsed / PRE_INTERVAL_MIN) + 1, Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)));
        const submitted = db.prepare("SELECT COUNT(*) AS c FROM pre_rounds WHERE pre_code=? AND round_key LIKE ?").get(pre, `%|${today}|%`)?.c ?? 0;
        const score = expected > 0 ? Math.round((Math.min(submitted, expected) / expected) * 100) : 100;
        return { pre, name: uid?.name ?? pre, shift, expected, submitted, score };
    });
    res.json({ date: today, compliance: rows });
}));
router.get("/snapshots", asyncH(async (_req, res) => {
    const rows = db.prepare("SELECT ts, total, vacant, reserved, occupied FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48").all();
    res.json({ snapshots: rows.reverse() });
}));
export default router;

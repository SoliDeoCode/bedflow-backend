import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { saveSubscription } from "../services/pushService.js";
import { pushEnabled, env } from "../config/env.js";
import { SHIFTS, COO_REMINDERS } from "../config/domain.js";
const router = Router();
router.get("/meta", (_req, res) => {
    res.json({ shifts: SHIFTS, cooReminders: COO_REMINDERS,
        pushEnabled, vapidPublic: env.VAPID_PUBLIC || null });
});
router.post("/push/subscribe", authRequired, asyncH(async (req, res) => {
    const { subscription } = z.object({ subscription: z.object({ endpoint: z.string() }).passthrough() }).parse(req.body);
    saveSubscription(req.user.id, subscription);
    res.json({ ok: true });
}));
export default router;

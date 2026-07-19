import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { saveSubscription } from "../services/pushService.js";
import { pushEnabled, env } from "../config/env.js";
import { COO_REMINDERS } from "../config/domain.js";
import { listDepartments, listDoctors } from "../services/doctorDeptService.js";

const router = Router();

router.get("/meta", (_req, res) => {
  res.json({ cooReminders: COO_REMINDERS,
    pushEnabled, vapidPublic: env.VAPID_PUBLIC || null });
});

router.get("/departments", authRequired, asyncH(async (_req, res) => {
  res.json({ departments: await listDepartments(true) });
}));

router.get("/doctors", authRequired, asyncH(async (req, res) => {
  const deptId = req.query.department_id ? Number(req.query.department_id) : undefined;
  res.json({ doctors: await listDoctors(deptId, true) });
}));

router.post("/push/subscribe", authRequired, asyncH(async (req, res) => {
  const { subscription } = z.object({ subscription: z.object({ endpoint: z.string() }).passthrough() }).parse(req.body);
  await saveSubscription(req.user!.id, subscription as { endpoint: string });
  res.json({ ok: true });
}));

export default router;

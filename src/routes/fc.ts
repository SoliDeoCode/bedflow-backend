import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import {
  createReopenRequest, listPendingRequests, listMyRequests,
  reviewRequest, pendingCount,
} from "../services/reopenRequestService.js";
import { emitUpdate } from "../websocket/io.js";
import { allWardsLive, allBedDetailsLive, adminDashboard, adminDashboardHistory, consultantsLive } from "../services/bedService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { db } from "../db/index.js";

const router = Router();
const FC_STEPS = ["BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT"] as const;
type FCStep = typeof FC_STEPS[number];

router.use(authRequired, requireRole("FC", "MASTER_FC"));

router.get("/reopen-pending-count", asyncH(async (req, res) => {
  const count = req.user!.role === "MASTER_FC"
    ? await pendingCount([...FC_STEPS])
    : 0;
  res.json({ count });
}));

router.post("/reopen-request", asyncH(async (req, res) => {
  const { admissionId, stepKey, reason } = z.object({
    admissionId: z.number().int(),
    stepKey: z.enum(FC_STEPS),
    reason: z.string().min(1).max(500),
  }).parse(req.body);

  const request = await createReopenRequest({
    admissionId, stepKey, reason, userId: req.user!.id,
  });
  emitUpdate("fc:reopen-request", { type: "new", request });
  res.status(201).json({ ok: true, request });
}));

router.get("/reopen-requests", asyncH(async (req, res) => {
  const steps = [...FC_STEPS];
  if (req.user!.role === "MASTER_FC") {
    res.json({ requests: await listPendingRequests(steps) });
  } else {
    res.json({ requests: await listMyRequests(req.user!.id, steps) });
  }
}));

router.post("/reopen-requests/:id/review", asyncH(async (req, res) => {
  if (req.user!.role !== "MASTER_FC")
    throw new HttpError(403, "Only Master FC can review reopen requests");

  const { action, reviewNote } = z.object({
    action: z.enum(["APPROVED", "DENIED"]),
    reviewNote: z.string().max(500).nullable().optional(),
  }).parse(req.body);

  const result = await reviewRequest({
    requestId: Number(req.params.id),
    action, reviewNote,
    userId: req.user!.id,
    role: req.user!.role,
  });
  emitUpdate("fc:reopen-request", { type: "reviewed", request: result });
  emitUpdate("discharge:update", { type: "reopen" });
  res.json({ ok: true, request: result });
}));

// ── Hospital-wide dashboard (read-only) ──────────────────────────────────────

router.get("/live-wards", asyncH(async (_req, res) => {
  res.json(await allWardsLive());
}));

router.get("/bed-details", asyncH(async (_req, res) => {
  res.json(await allBedDetailsLive());
}));

router.get("/admin-dashboard", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json(await adminDashboard(unit));
}));

router.get("/admin-dashboard-history", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json({ snapshots: await adminDashboardHistory(48, unit) });
}));

router.get("/consultants", asyncH(async (_req, res) => {
  res.json(await consultantsLive());
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/snapshots", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT ts,total,vacant,reserved,occupied,payer_snapshot FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48"
  ).all<{ ts: number; total: number; vacant: number; reserved: number; occupied: number; payer_snapshot: Record<string, number> | null }>();
  const snapshots = rows.reverse().map((r) => ({ ...r, payers: r.payer_snapshot || {} }));
  res.json({ snapshots });
}));

router.get("/overstay", asyncH(async (_req, res) => {
  const IST = 5.5 * 3600 * 1000;
  const todayIST = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const rows = await db.prepare(`
    SELECT
      pa.id AS admission_id, pa.ip_last6, pa.admitted_at,
      COALESCE(dm.name, pa.consultant_name, 'Unknown') AS doctor,
      w.name AS ward, bd.bed_name AS bed,
      dt.planned_date, dt.status AS discharge_status,
      (CURRENT_DATE - dt.planned_date::date) AS days_overdue
    FROM patient_admissions pa
    JOIN discharge_tracking dt ON dt.admission_id = pa.id
    JOIN wards w ON w.id = pa.ward_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    LEFT JOIN doctors_master dm ON dm.id = pa.doctor_id
    WHERE pa.status = 'ACTIVE'
      AND dt.status NOT IN ('COMPLETED', 'CANCELLED')
      AND dt.planned_date < ?
    ORDER BY days_overdue DESC, pa.admitted_at ASC
  `).all(todayIST);
  const total = rows.length;
  const tier1 = rows.filter((r: any) => Number(r.days_overdue) === 1).length;
  const tier2 = rows.filter((r: any) => Number(r.days_overdue) >= 2 && Number(r.days_overdue) <= 3).length;
  const tier3 = rows.filter((r: any) => Number(r.days_overdue) >= 4).length;
  res.json({ total, tier1, tier2, tier3, rows });
}));

export default router;

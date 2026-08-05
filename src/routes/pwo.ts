import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import {
  listCategories, listPriorities, filterOptions,
  dashboardStats, charts, perPwoReport,
  listComplaints, getComplaintDetail,
  acceptComplaint, advanceStatus, setPriority, addNote,
  COMPLAINT_STATUSES,
} from "../services/complaintService.js";

/* Patient Welfare Officer API. Thin controllers: parse + validate, delegate to
   complaintService, return. Every route is PWO-only — complaint content is
   patient grievance data (staff/doctor conduct, billing disputes) and is not
   exposed to other staff roles. Admin oversight is deliberately not built yet. */
const router = Router();
router.use(authRequired, requireRole("PWO"));

const idParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new z.ZodError([]);
  return n;
};

// ── Bootstrap: everything the dashboard needs to render its filters once ────
router.get("/meta", asyncH(async (_req, res) => {
  const [categories, priorities, options] = await Promise.all([
    listCategories(), listPriorities(), filterOptions(),
  ]);
  res.json({ categories, priorities, ...options });
}));

// ── Dashboard cards + charts ────────────────────────────────────────────────
router.get("/dashboard", asyncH(async (_req, res) => {
  res.json({ stats: await dashboardStats() });
}));

router.get("/charts", asyncH(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  res.json({ charts: await charts(days) });
}));

router.get("/reports/per-pwo", asyncH(async (_req, res) => {
  res.json({ officers: await perPwoReport() });
}));

// ── Queue ───────────────────────────────────────────────────────────────────
router.get("/complaints", asyncH(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

  const status = q.status && (COMPLAINT_STATUSES as readonly string[]).includes(q.status) ? q.status : undefined;

  res.json(await listComplaints({
    status,
    categoryId: int(q.categoryId),
    priorityId: int(q.priorityId),
    wardId: int(q.wardId),
    floorId: int(q.floorId),
    departmentId: int(q.departmentId),
    ownerPwoId: int(q.ownerPwoId),
    unassigned: q.unassigned === "true",
    from: int(q.from),
    to: int(q.to),
    search: q.search,
    sort: q.sort,
    page: int(q.page),
    pageSize: int(q.pageSize),
  }));
}));

router.get("/complaints/:id", asyncH(async (req, res) => {
  res.json({ complaint: await getComplaintDetail(idParam(req.params.id)) });
}));

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Claim an OPEN complaint. Races are resolved in the service by a conditional
 *  UPDATE — the loser gets a 409 naming whoever won, never a silent overwrite. */
router.post("/complaints/:id/accept", asyncH(async (req, res) => {
  res.json({ complaint: await acceptComplaint(idParam(req.params.id), req.user!.id) });
}));

router.patch("/complaints/:id/status", asyncH(async (req, res) => {
  const { status, note } = z.object({
    status: z.enum(COMPLAINT_STATUSES),
    note: z.string().max(4000).nullable().optional(),
  }).parse(req.body);

  res.json({
    complaint: await advanceStatus({
      complaintId: idParam(req.params.id),
      toStatus: status,
      pwoUserId: req.user!.id,
      note,
    }),
  });
}));

router.patch("/complaints/:id/priority", asyncH(async (req, res) => {
  const { priority } = z.object({ priority: z.string().min(1).max(20) }).parse(req.body);
  res.json({
    complaint: await setPriority({
      complaintId: idParam(req.params.id),
      priorityCode: priority,
      pwoUserId: req.user!.id,
    }),
  });
}));

/** Notes are internal unless explicitly shared — visibleToPatient defaults to
 *  false so forgetting the flag can never leak an internal note to the
 *  (unauthenticated) patient portal. */
router.post("/complaints/:id/notes", asyncH(async (req, res) => {
  const { note, visibleToPatient } = z.object({
    note: z.string().min(1).max(4000),
    visibleToPatient: z.boolean().optional().default(false),
  }).parse(req.body);

  res.status(201).json({
    note: await addNote({
      complaintId: idParam(req.params.id),
      pwoUserId: req.user!.id,
      note,
      visibleToPatient,
    }),
  });
}));

export default router;

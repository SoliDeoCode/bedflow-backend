import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { z } from "zod";
import { orgOverview } from "../services/bedService.js";
import { alarmState, userShift } from "../services/roundService.js";
import { recentAudit } from "../services/auditService.js";
import { db } from "../db/index.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, startOfDayIST, PRE_INTERVAL_MIN, SHIFTS } from "../config/domain.js";

const router = Router();
router.use(authRequired, requireRole("COO", "MANAGER"));

router.get("/overview", asyncH(async (_req, res) => {
  const base = await orgOverview();
  const floors = await Promise.all(base.floors.map(async (f) => ({
    ...f,
    pres: await Promise.all(f.pres.map(async (p) => {
      // Find the PRE user assigned to this block for alarm state
      const block = await db.prepare("SELECT id FROM blocks WHERE name_key=?")
        .get<{ id: number }>(p.pre.toUpperCase().trim());
      const uid = block
        ? await db.prepare("SELECT id FROM users WHERE block_id=? AND role='PRE'")
            .get<{ id: number }>(block.id)
        : null;
      const shift = uid ? await userShift(uid.id) : "morning";
      return { ...p, alarm: await alarmState(p.pre, shift) };
    })),
  })));
  const mins = minsNow();
  const dueReminder = COO_REMINDERS.find(r => {
    const m = hmToMin(r); return mins >= m && mins < m + 30;
  }) || null;
  res.json({ floors, totals: base.totals, dueReminder });
}));

router.get("/audit", asyncH(async (_req, res) => {
  res.json({ logs: await recentAudit(150) });
}));

router.get("/compliance", asyncH(async (_req, res) => {
  const today = todayStr();
  const mins  = minsNow();

  // All blocks that have at least one ward
  const blocks = await db.prepare(
    `SELECT b.id, b.name,
            u.id AS user_id, u.shift, u.name AS user_name
     FROM blocks b
     LEFT JOIN users u ON u.block_id = b.id AND u.role = 'PRE'
     WHERE EXISTS (SELECT 1 FROM wards w WHERE w.block_id = b.id)
     ORDER BY b.sort_order, b.name`
  ).all<{ id: number; name: string; user_id: number | null; shift: string; user_name: string }>();

  const rows = await Promise.all(blocks.map(async block => {
    const shift = (block.shift as keyof typeof SHIFTS) || "morning";
    const s     = SHIFTS[shift];
    const start = hmToMin(s.start);
    let elapsed = mins - start; if (elapsed < 0) elapsed = 0;
    const expected = Math.max(0, Math.min(
      Math.floor(elapsed / PRE_INTERVAL_MIN) + 1,
      Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)
    ));
    const submittedRow = await db.prepare(
      "SELECT COUNT(*) AS c FROM pre_rounds WHERE block_id=? AND submitted_at>=?"
    ).get<{ c: number }>(block.id, startOfDayIST());
    const submitted = submittedRow?.c ?? 0;
    const score = expected > 0
      ? Math.round((Math.min(submitted, expected) / expected) * 100)
      : 100;
    return { blockId: block.id, block: block.name, name: block.user_name ?? block.name,
             shift, expected, submitted, score };
  }));
  res.json({ date: today, compliance: rows });
}));

router.get("/snapshots", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT ts,total,vacant,reserved,occupied FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48"
  ).all();
  res.json({ snapshots: rows.reverse() });
}));

// ── Saved Views ───────────────────────────────────────────────────────────────

interface SavedViewRow {
  id: number; name: string; created_by: number | null;
  selected_wards: string; is_shared: number; is_system: number;
  created_at: number; updated_at: number;
}

function parseView(v: SavedViewRow, currentUserId: number) {
  return {
    id: v.id,
    name: v.name,
    selected_wards: JSON.parse(v.selected_wards) as string[],
    is_shared: !!v.is_shared,
    is_system: !!v.is_system,
    mine: v.created_by === currentUserId,
    created_at: v.created_at,
    updated_at: v.updated_at,
    // Note: created_by user ID intentionally omitted — frontend only needs `mine`.
  };
}

router.get("/views", asyncH(async (req, res) => {
  const userId = req.user!.id;
  const rows = await db.prepare(`
    SELECT id, name, created_by, selected_wards, is_shared, is_system, created_at, updated_at
    FROM saved_views
    WHERE is_system = 1 OR is_shared = 1 OR created_by = ?
    ORDER BY is_system DESC, name ASC
  `).all<SavedViewRow>(userId);
  res.json({ views: rows.map(r => parseView(r, userId)) });
}));

router.post("/views", asyncH(async (req, res) => {
  const { name, selected_wards, is_shared } = z.object({
    name:           z.string().min(1).max(60),
    selected_wards: z.array(z.string()),
    is_shared:      z.boolean().optional().default(false),
  }).parse(req.body);
  const now = Date.now();
  // RETURNING id so lastInsertRowid works in PostgreSQL
  const r = await db.prepare(
    `INSERT INTO saved_views (name, created_by, selected_wards, is_shared, is_system, created_at, updated_at)
     VALUES (?,?,?,?,0,?,?) RETURNING id`
  ).run(name, req.user!.id, JSON.stringify(selected_wards), is_shared ? 1 : 0, now, now);
  res.status(201).json({ ok: true, id: r.lastInsertRowid });
}));

router.put("/views/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const view = await db.prepare("SELECT * FROM saved_views WHERE id=?").get<SavedViewRow>(id);
  if (!view) throw new HttpError(404, "View not found");
  if (view.is_system) throw new HttpError(403, "System views cannot be edited");
  if (view.created_by !== req.user!.id) throw new HttpError(403, "Not your view");
  const { name, selected_wards, is_shared } = z.object({
    name:           z.string().min(1).max(60),
    selected_wards: z.array(z.string()),
    is_shared:      z.boolean(),
  }).parse(req.body);
  await db.prepare(
    "UPDATE saved_views SET name=?, selected_wards=?, is_shared=?, updated_at=? WHERE id=?"
  ).run(name, JSON.stringify(selected_wards), is_shared ? 1 : 0, Date.now(), id);
  res.json({ ok: true });
}));

router.delete("/views/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const view = await db.prepare("SELECT * FROM saved_views WHERE id=?").get<SavedViewRow>(id);
  if (!view) throw new HttpError(404, "View not found");
  if (view.is_system) throw new HttpError(403, "System views cannot be deleted");
  if (view.created_by !== req.user!.id) throw new HttpError(403, "Not your view");
  await db.prepare("DELETE FROM saved_views WHERE id=?").run(id);
  res.json({ ok: true });
}));

export default router;

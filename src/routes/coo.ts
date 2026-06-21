import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { z } from "zod";
import { orgOverview, allWardsLive } from "../services/bedService.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, startOfDayIST, PRE_INTERVAL_MIN, SHIFTS,
         currentRound, inShift, roundKey, type ShiftKey } from "../config/domain.js";
import { recentAudit, queryActivity } from "../services/auditService.js";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";

const router = Router();
router.use(authRequired, requireRole("COO"));

router.get("/overview", asyncH(async (_req, res) => {
  const base = await orgOverview();
  const mins = minsNow();
  const today = todayStr();

  const allPres = base.floors.flatMap(g => g.pres);

  let alarmByFloorId = new Map<number, object>();

  if (allPres.length > 0) {
    const floorIds = allPres.map(p => p.floor_id);

    // Batch: ward counts per pre_block (floor_id used as pre_block_id for legacy compat)
    const wardCountRows = await db.prepare(
      `SELECT pre_block_id, COUNT(*) AS n FROM pre_block_wards
       WHERE pre_block_id = ANY(?) GROUP BY pre_block_id`
    ).all<{ pre_block_id: number; n: number }>(floorIds);
    const wardCountByBlock = new Map(wardCountRows.map(r => [Number(r.pre_block_id), Number(r.n)]));

    // Compute current round keys for all floors (pure JS, no DB)
    const keyMeta = new Map<number, { shift: ShiftKey; round: ReturnType<typeof currentRound>; key: string }>();
    const allKeys: string[] = [];
    for (const p of allPres) {
      const shift = (p.assignedUser?.shift as ShiftKey) || "morning";
      const round = currentRound(shift, mins);
      const key   = roundKey(`pb${p.floor_id}`, shift, today, round.startMin);
      keyMeta.set(p.floor_id, { shift, round, key });
      allKeys.push(key);
    }

    // Batch: which round keys have been submitted
    const submittedRows = await db.prepare(
      `SELECT round_key FROM pre_rounds WHERE round_key = ANY(?)`
    ).all<{ round_key: string }>(allKeys);
    const submittedKeys = new Set(submittedRows.map(r => r.round_key));

    for (const p of allPres) {
      const { shift, round, key } = keyMeta.get(p.floor_id)!;
      const onDuty   = inShift(shift, mins);
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
    const m = hmToMin(r); return mins >= m && mins < m + 30;
  }) || null;
  res.json({ floors, totals: base.totals, dueReminder });
}));

router.get("/live-wards", asyncH(async (_req, res) => {
  res.json(await allWardsLive());
}));

router.get("/audit", asyncH(async (_req, res) => {
  res.json({ logs: await recentAudit(150) });
}));

// Unified, filterable, keyset-paginated activity history (PRE + Nurse + all roles).
router.get("/activity", asyncH(async (req, res) => {
  const q = z.object({
    from:       z.coerce.number().int().optional(),
    to:         z.coerce.number().int().optional(),
    roles:      z.string().optional(),       // CSV: PRE,NURSE,COO
    userId:     z.coerce.number().int().positive().optional(),
    categories: z.string().optional(),       // CSV: bed,round,config,login
    q:          z.string().max(100).optional(),
    page:       z.coerce.number().int().min(1).optional(),
    limit:      z.coerce.number().int().min(1).max(200).optional(),
  }).parse(req.query);

  const splitCsv = (s?: string) =>
    s ? s.split(",").map(x => x.trim()).filter(Boolean) : undefined;

  res.json(await queryActivity({
    from: q.from, to: q.to,
    roles: splitCsv(q.roles),
    userId: q.userId,
    categories: splitCsv(q.categories),
    q: q.q,
    page: q.page, limit: q.limit,
  }));
}));

// Rounds are submitted per PRE Block — compliance is scored per active PRE
// Block with wards, using the assigned PRE user's shift.
router.get("/compliance", asyncH(async (_req, res) => {
  const today = todayStr();
  const mins  = minsNow();
  const dayStart = startOfDayIST();

  const blocks = await db.prepare(
    `SELECT pb.id, pb.name
     FROM pre_blocks pb
     WHERE pb.status = 'active'
       AND EXISTS (SELECT 1 FROM pre_block_wards pbw WHERE pbw.pre_block_id = pb.id)
     ORDER BY pb.name`
  ).all<{ id: number; name: string }>();

  if (blocks.length === 0) return res.json({ date: today, compliance: [] });

  const blockIds = blocks.map(b => b.id);

  // Batch: one PRE user per block
  const userRows = await db.prepare(
    `SELECT DISTINCT ON (pre_block_id) id, shift, name, pre_block_id
     FROM users WHERE role = 'PRE' AND pre_block_id = ANY(?) ORDER BY pre_block_id, id`
  ).all<{ id: number; shift: string; name: string; pre_block_id: number }>(blockIds);
  const userByBlock = new Map(userRows.map(u => [Number(u.pre_block_id), u]));

  // Batch: submitted round counts per block since start of day
  const countRows = await db.prepare(
    `SELECT pre_block_id, COUNT(*) AS c
     FROM pre_rounds WHERE pre_block_id = ANY(?) AND submitted_at >= ? GROUP BY pre_block_id`
  ).all<{ pre_block_id: number; c: number }>(blockIds, dayStart);
  const countByBlock = new Map(countRows.map(r => [Number(r.pre_block_id), Number(r.c)]));

  const rows = blocks.map(block => {
    const user      = userByBlock.get(block.id);
    const shift     = (user?.shift as keyof typeof SHIFTS) || "morning";
    const s         = SHIFTS[shift];
    const start     = hmToMin(s.start);
    let elapsed     = mins - start; if (elapsed < 0) elapsed += 1440; // cross-midnight shift
    const expected  = Math.max(0, Math.min(
      Math.floor(elapsed / PRE_INTERVAL_MIN) + 1,
      Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)
    ));
    const submitted = countByBlock.get(block.id) ?? 0;
    const score     = expected > 0
      ? Math.round((Math.min(submitted, expected) / expected) * 100)
      : 100;
    return {
      preBlockId: block.id,
      floorId:    block.id,
      floor: block.name, block: block.name,
      name:   user?.name ?? block.name,
      hasPre: !!user,
      shift, expected, submitted, score,
    };
  });
  res.json({ date: today, compliance: rows });
}));

// ── PRE activity — all blocks with ward counts, rounds today, compliance ──────
router.get("/pre-activity", asyncH(async (_req, res) => {
  const today  = startOfDayIST();
  const mins   = minsNow();

  const blocks = await db.prepare(
    `SELECT pb.id, pb.name, pb.status FROM pre_blocks pb ORDER BY pb.name`
  ).all<{ id: number; name: string; status: string }>();

  if (blocks.length === 0) return res.json({ blocks: [] });
  const blockIds = blocks.map(b => b.id);

  const userRows = await db.prepare(
    `SELECT DISTINCT ON (pre_block_id) id, name, shift, pre_block_id
     FROM users WHERE role = 'PRE' AND pre_block_id = ANY(?) ORDER BY pre_block_id, id`
  ).all<{ id: number; name: string; shift: string; pre_block_id: number }>(blockIds);
  const userByBlock = new Map(userRows.map(u => [Number(u.pre_block_id), u]));

  const wardRows = await db.prepare(
    `SELECT pbw.pre_block_id, w.id, w.name AS ward, w.total_beds AS total,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     WHERE pbw.pre_block_id = ANY(?) AND w.operational = true
     ORDER BY pbw.pre_block_id, w.name`
  ).all<{ pre_block_id: number; id: number; ward: string; total: number;
          vacant: number|null; reserved: number|null; occupied: number|null;
          occupied_reserved: number|null; updatedAt: number|null }>(blockIds);
  const wardsByBlock = new Map<number, typeof wardRows>();
  for (const w of wardRows) {
    const k = Number(w.pre_block_id);
    if (!wardsByBlock.has(k)) wardsByBlock.set(k, []);
    wardsByBlock.get(k)!.push(w);
  }

  const roundRows = await db.prepare(
    `SELECT pre_block_id, COUNT(*) AS c, MAX(submitted_at) AS last_at
     FROM pre_rounds WHERE pre_block_id = ANY(?) AND submitted_at >= ?
     GROUP BY pre_block_id`
  ).all<{ pre_block_id: number; c: number; last_at: number }>(blockIds, today);
  const roundsByBlock = new Map(roundRows.map(r => [Number(r.pre_block_id), r]));

  const result = blocks.map(block => {
    const user     = userByBlock.get(block.id);
    const shift    = (user?.shift as keyof typeof SHIFTS) || "morning";
    const s        = SHIFTS[shift];
    const start    = hmToMin(s.start);
    let   elapsed  = mins - start; if (elapsed < 0) elapsed = 0;
    const expected = Math.max(0, Math.min(
      Math.floor(elapsed / PRE_INTERVAL_MIN) + 1,
      Math.floor((hmToMin(s.end) - start + 1440) % 1440 / PRE_INTERVAL_MIN)
    ));
    const rounds    = roundsByBlock.get(block.id);
    const submitted = Number(rounds?.c ?? 0);
    const score     = expected > 0 ? Math.round((Math.min(submitted, expected) / expected) * 100) : 100;
    return {
      id: block.id, name: block.name, status: block.status,
      assignedUser:    user ? { id: user.id, name: user.name, shift: user.shift } : null,
      wards:           wardsByBlock.get(block.id) ?? [],
      roundsToday:     submitted,
      lastSubmittedAt: rounds?.last_at ?? null,
      compliance:      { expected, submitted, score },
    };
  });
  res.json({ blocks: result });
}));

// ── Nurse activity — all stations with nurses, assigned wards, last updates ──
router.get("/nurse-activity", asyncH(async (_req, res) => {
  const stations = await db.prepare(
    `SELECT id, name FROM nursing_stations ORDER BY name`
  ).all<{ id: number; name: string }>();

  const nurses = await db.prepare(
    `SELECT id, name, username, station_id FROM users WHERE role = 'NURSE' ORDER BY name`
  ).all<{ id: number; name: string; username: string; station_id: number|null }>();

  const wards = await db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.station_id,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved,
            b.updated_at AS "updatedAt", b.updated_by
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.operational = true ORDER BY w.name`
  ).all<{ id: number; ward: string; total: number; station_id: number|null;
          vacant: number|null; reserved: number|null; occupied: number|null;
          occupied_reserved: number|null; updatedAt: number|null; updated_by: number|null }>();

  // Resolve updater names
  const updaterIds = [...new Set(wards.map(w => w.updated_by).filter((x): x is number => x != null))];
  let nameMap = new Map<number, string>();
  if (updaterIds.length > 0) {
    const uRows = await db.prepare(
      `SELECT id, name, role FROM users WHERE id = ANY(?)`
    ).all<{ id: number; name: string; role: string }>(updaterIds);
    for (const u of uRows) nameMap.set(u.id, `${u.name} (${u.role})`);
  }

  const mapWard = (w: typeof wards[0]) => ({
    id: w.id, ward: w.ward, total: w.total,
    vacant: w.vacant, reserved: w.reserved,
    occupied: w.occupied, occupied_reserved: w.occupied_reserved,
    updatedAt: w.updatedAt,
    updatedBy: w.updated_by ? (nameMap.get(w.updated_by) ?? null) : null,
  });

  const nursesByStation  = new Map<number|null, typeof nurses>();
  const wardsByStation   = new Map<number|null, typeof wards>();
  for (const n of nurses) { const k = n.station_id; if (!nursesByStation.has(k)) nursesByStation.set(k,[]); nursesByStation.get(k)!.push(n); }
  for (const w of wards)  { const k = w.station_id;  if (!wardsByStation.has(k))  wardsByStation.set(k,[]);  wardsByStation.get(k)!.push(w);  }

  const stationData = stations.map(s => ({
    id: s.id, name: s.name,
    nurses: (nursesByStation.get(s.id) ?? []).map(n => ({ id: n.id, name: n.name, username: n.username })),
    wards:  (wardsByStation.get(s.id)  ?? []).map(mapWard),
  }));

  res.json({
    stations:          stationData,
    unassignedNurses:  (nursesByStation.get(null) ?? []).map(n => ({ id: n.id, name: n.name, username: n.username })),
    unassignedWards:   (wardsByStation.get(null)  ?? []).map(mapWard),
  });
}));

router.get("/snapshots", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT ts,total,vacant,reserved,occupied,payer_snapshot FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48"
  ).all<{ ts: number; total: number; vacant: number; reserved: number; occupied: number; payer_snapshot: Record<string, number> | null }>();
  // pg auto-parses the jsonb column; older rows predate this column and are NULL.
  const snapshots = rows.reverse().map((r) => ({ ...r, payers: r.payer_snapshot || {} }));
  res.json({ snapshots });
}));

// Occupancy trend for the dashboard chart.
// - "today": hourly occupancy_snapshots for the current IST day.
// - "7d": hourly occupancy_snapshots across the full 7-day window — real
//   timestamped history, not just one point per day — falling back to that
//   single day's midnight_census point only for days with zero snapshots
//   (e.g. the server was down through midnight that day).
// - "30d"/"1y": one point per day from midnight_census; hourly granularity
//   over that many days would be hundreds/thousands of points and isn't
//   practical for this chart.
router.get("/occupancy-trend", asyncH(async (req, res) => {
  const range = String(req.query.range || "7d");
  const points: Array<{ label: string; pct: number }> = [];
  const IST = 5.5 * 3600 * 1000;
  const startOfTodayIST = Math.floor((Date.now() + IST) / 86400000) * 86400000 - IST;

  if (range === "today") {
    const rows = await db.prepare(
      "SELECT ts,total,occupied FROM occupancy_snapshots WHERE ts >= ? ORDER BY ts ASC"
    ).all<{ ts: number; total: number; occupied: number }>(startOfTodayIST);
    for (const r of rows) {
      const pct = r.total > 0 ? Math.round((r.occupied / r.total) * 100) : 0;
      points.push({ label: new Date(Number(r.ts)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }), pct });
    }
  } else if (range === "7d") {
    const windowStart = startOfTodayIST - 6 * 86400000; // today + 6 days back = 7 calendar days
    const rows = await db.prepare(
      "SELECT ts,total,occupied FROM occupancy_snapshots WHERE ts >= ? ORDER BY ts ASC"
    ).all<{ ts: number; total: number; occupied: number }>(windowStart);

    const hourlyPoints = rows.map((r) => ({
      ts: Number(r.ts),
      label: new Date(Number(r.ts)).toLocaleString("en-IN", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
      }),
      pct: r.total > 0 ? Math.round((r.occupied / r.total) * 100) : 0,
    }));
    // Which IST calendar days in the window actually have an hourly snapshot
    const daysWithSnapshots = new Set(rows.map((r) => new Date(Number(r.ts) + IST).toISOString().slice(0, 10)));

    // Fill any day in the window with zero hourly data using its midnight_census point,
    // so a server-downtime gap shows as one sparse point instead of a dead blank stretch.
    const censusRows = await db.prepare(
      "SELECT census_date, ts, snapshot FROM midnight_census WHERE census_date >= ? ORDER BY census_date ASC"
    ).all<{ census_date: string; ts: number; snapshot: string }>(
      new Date(windowStart + IST).toISOString().slice(0, 10)
    );
    const fallbackPoints = censusRows
      .filter((row) => !daysWithSnapshots.has(row.census_date))
      .map((row) => {
        let total = 0, occ = 0;
        try {
          const wards = JSON.parse(row.snapshot) as Array<{ total: number; occupied: number; occupied_reserved: number }>;
          for (const w of wards) { total += w.total || 0; occ += (w.occupied || 0) + (w.occupied_reserved || 0); }
        } catch { /* skip malformed */ }
        const d = new Date(row.census_date + "T00:00:00");
        return {
          ts: Number(row.ts),
          label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " (midnight only)",
          pct: total > 0 ? Math.round((occ / total) * 100) : 0,
        };
      });

    for (const p of [...hourlyPoints, ...fallbackPoints].sort((a, b) => a.ts - b.ts))
      points.push({ label: p.label, pct: p.pct });
  } else {
    const days = range === "1y" ? 365 : 30;
    const rows = await db.prepare(
      "SELECT census_date, snapshot FROM midnight_census ORDER BY census_date DESC LIMIT ?"
    ).all<{ census_date: string; snapshot: string }>(days);
    for (const row of rows.reverse()) {
      let total = 0, occ = 0;
      try {
        const wards = JSON.parse(row.snapshot) as Array<{ total: number; occupied: number; occupied_reserved: number }>;
        for (const w of wards) { total += w.total || 0; occ += (w.occupied || 0) + (w.occupied_reserved || 0); }
      } catch { /* skip malformed */ }
      const pct = total > 0 ? Math.round((occ / total) * 100) : 0;
      const d = new Date(row.census_date + "T00:00:00");
      points.push({ label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), pct });
    }
  }

  const vals = points.map((p) => p.pct);
  const avg  = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  let high = { pct: 0, label: "—" }, low = { pct: 0, label: "—" };
  if (points.length) {
    high = points.reduce((m, p) => (p.pct > m.pct ? p : m), points[0]);
    low  = points.reduce((m, p) => (p.pct < m.pct ? p : m), points[0]);
  }
  res.json({ points, avg, high, low });
}));

// ── Saved Views ───────────────────────────────────────────────────────────────

interface SavedViewRow {
  id: number; name: string; created_by: number | null;
  selected_wards: string; is_shared: number; is_system: number; source: string;
  created_at: number; updated_at: number;
}

const VIEW_SOURCES = ["matrix", "midnight_census"] as const;

function parseView(v: SavedViewRow, currentUserId: number) {
  return {
    id: v.id, name: v.name,
    selected_wards: JSON.parse(v.selected_wards) as string[],
    is_shared: !!v.is_shared,
    is_system: !!v.is_system,
    source: v.source,
    mine: v.created_by === currentUserId,
    created_at: v.created_at, updated_at: v.updated_at,
  };
}

router.get("/views", asyncH(async (req, res) => {
  const userId = req.user!.id;
  const source = VIEW_SOURCES.includes(req.query.source as any) ? String(req.query.source) : "matrix";
  const rows = await db.prepare(`
    SELECT id, name, created_by, selected_wards, is_shared, is_system, source, created_at, updated_at
    FROM saved_views
    WHERE (is_system = 1 OR is_shared = 1 OR created_by = ?) AND source = ?
    ORDER BY is_system DESC, name ASC
  `).all<SavedViewRow>(userId, source);
  res.json({ views: rows.map(r => parseView(r, userId)) });
}));

router.post("/views", asyncH(async (req, res) => {
  const { name, selected_wards, is_shared, source } = z.object({
    name:           z.string().min(1).max(60),
    selected_wards: z.array(z.string()),
    is_shared:      z.boolean().optional().default(false),
    source:         z.enum(VIEW_SOURCES).optional().default("matrix"),
  }).parse(req.body);
  const now = Date.now();
  const r = await db.prepare(
    `INSERT INTO saved_views (name, created_by, selected_wards, is_shared, is_system, source, created_at, updated_at)
     VALUES (?,?,?,?,0,?,?,?) RETURNING id`
  ).run(name, req.user!.id, JSON.stringify(selected_wards), is_shared ? 1 : 0, source, now, now);
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

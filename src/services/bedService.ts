import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { startOfDayIST } from "../config/domain.js";

export interface WardView {
  id: number; ward: string; total: number;
  vacant: number | null; reserved: number | null; occupied: number | null;
  occupied_reserved: number | null;
  updatedAt: number | null;
  unit_type: string | null;
  station_id: number | null;
  nursing_station: string | null;
  operational: boolean;
}

export interface PreSummary {
  v: number; r: number; o: number; or: number;
  total: number; wards: number; wardsDone: number; complete: boolean;
}

export async function wardsForFloor(floorId: number): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.floor_id = ? ORDER BY w.name`
  ).all<WardView>(floorId);
}

export async function wardsForPreBlock(preBlockId: number): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type, w.operational,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     WHERE pbw.pre_block_id = ? ORDER BY w.operational DESC, w.name`
  ).all<WardView>(preBlockId);
}

export function summarize(wards: WardView[]): PreSummary {
  let v = 0, r = 0, o = 0, or_ = 0, total = 0, wardsDone = 0;
  // Non-operational wards are shown to PRE but excluded from round counts
  const opWards = wards.filter(w => w.operational !== false);
  for (const w of opWards) {
    total += w.total;
    if (w.vacant !== null) {
      wardsDone++;
      v   += w.vacant            || 0;
      r   += w.reserved          || 0;
      o   += w.occupied          || 0;
      or_ += w.occupied_reserved || 0;
    }
  }
  return { v, r, o, or: or_, total, wards: opWards.length, wardsDone,
           complete: opWards.length > 0 && wardsDone === opWards.length };
}

export async function updateWard(
  wardId: number,
  vacantNone: number, vacantReserved: number,
  occupiedNone: number, occupiedReserved: number,
  userId: number
) {
  const ward = await db.prepare(
    "SELECT id, name, total_beds AS total, floor_id FROM wards WHERE id = ?"
  ).get<{ id: number; name: string; total: number; floor_id: number }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");

  const vn  = Math.max(0, Math.floor(vacantNone));
  const vr  = Math.max(0, Math.floor(vacantReserved));
  const on_ = Math.max(0, Math.floor(occupiedNone));
  const or_ = Math.max(0, Math.floor(occupiedReserved));
  if (vn + vr + on_ + or_ !== ward.total)
    throw new HttpError(400, `Counts must total ${ward.total} beds`);

  const now = Date.now();
  await db.transaction(async () => {
    await db.prepare(
      "UPDATE beds SET vacant=?, reserved=?, occupied=?, occupied_reserved=?, updated_at=?, updated_by=? WHERE ward_id=?"
    ).run(vn, vr, on_, or_, now, userId, wardId);
    await db.prepare(
      "INSERT INTO bed_status_updates (ward_id, ward_name, vacant_none, vacant_reserved, occupied_none, occupied_reserved, updated_by, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(wardId, ward.name, vn, vr, on_, or_, userId, now);
  });

  const floorLabel = ward.floor_id
    ? (await db.prepare("SELECT name FROM floors WHERE id = ?")
        .get<{ name: string }>(ward.floor_id))?.name ?? String(ward.floor_id)
    : "unknown";
  await audit(userId, "ward_update", floorLabel, {
    ward: ward.name, vacant_none: vn, vacant_reserved: vr, occupied_none: on_, occupied_reserved: or_,
  });
  return { ward: ward.name, vacant: vn, reserved: vr, occupied: on_, occupied_reserved: or_, total: ward.total };
}

interface FloorOverviewItem {
  floor_id: number;
  building_block_id: number;
  pre: string;
  floor: string;
  label: string;
  wards: WardView[];
  summary: PreSummary;
  lastSubmittedAt: number | null;
  roundsToday: number;
  assignedUser: { id: number; name: string; shift: string } | null;
}

export async function orgOverview(): Promise<{
  floors: { name: string; pres: FloorOverviewItem[] }[];
  totals: { v: number; r: number; o: number; or: number; total: number; presReporting: number; presTotal: number };
}> {
  // Each pre_block is annotated with the building_block of its first ward (lowest bb sort_order).
  // Wards that have no floor_id (or no building_block) get building_block_id = NULL → "Other" group.
  const preBlocks = await db.prepare(
    `SELECT DISTINCT ON (pb.id)
       pb.id, pb.name,
       bb.id   AS building_block_id,
       bb.name AS bb_name,
       bb.label AS bb_label,
       COALESCE(bb.sort_order, 9999) AS bb_sort
     FROM pre_blocks pb
     LEFT JOIN pre_block_wards pbw ON pbw.pre_block_id = pb.id
     LEFT JOIN wards w ON w.id = pbw.ward_id
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     ORDER BY pb.id, bb.sort_order NULLS LAST`
  ).all<{
    id: number; name: string;
    building_block_id: number | null; bb_name: string | null; bb_label: string | null;
    bb_sort: number;
  }>();

  const today = startOfDayIST();

  if (preBlocks.length === 0) {
    return { floors: [], totals: { v: 0, r: 0, o: 0, or: 0, total: 0, presReporting: 0, presTotal: 0 } };
  }

  const blockIds = preBlocks.map(pb => pb.id);

  // Batch 1: all wards for all pre_blocks (station_id/nursing_station exposed so the
  // frontend can pivot to a nursing-station view without an extra round-trip)
  const allWardRows = await db.prepare(
    `SELECT pbw.pre_block_id, w.id, w.name AS ward, w.total_beds AS total, w.unit_type,
            w.station_id, w.nursing_station,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     WHERE pbw.pre_block_id = ANY(?) AND w.operational = true
     ORDER BY pbw.pre_block_id, w.name`
  ).all<WardView & { pre_block_id: number }>(blockIds);
  const wardsByBlock = new Map<number, WardView[]>();
  for (const { pre_block_id, ...w } of allWardRows) {
    const key = Number(pre_block_id);
    if (!wardsByBlock.has(key)) wardsByBlock.set(key, []);
    wardsByBlock.get(key)!.push(w);
  }

  // Batch 2: last submitted round per pre_block
  const lastRoundRows = await db.prepare(
    `SELECT pre_block_id, MAX(submitted_at) AS submitted_at
     FROM pre_rounds WHERE pre_block_id = ANY(?) GROUP BY pre_block_id`
  ).all<{ pre_block_id: number; submitted_at: number }>(blockIds);
  const lastRoundByBlock = new Map(lastRoundRows.map(r => [Number(r.pre_block_id), Number(r.submitted_at)]));

  // Batch 3: rounds submitted today per pre_block
  const countRows = await db.prepare(
    `SELECT pre_block_id, COUNT(*) AS c
     FROM pre_rounds WHERE submitted_at >= ? AND pre_block_id = ANY(?) GROUP BY pre_block_id`
  ).all<{ pre_block_id: number; c: number }>(today, blockIds);
  const roundCountByBlock = new Map(countRows.map(r => [Number(r.pre_block_id), Number(r.c)]));

  // Batch 4: one PRE user per pre_block
  const preUsers = await db.prepare(
    `SELECT DISTINCT ON (pre_block_id) id, name, shift, pre_block_id
     FROM users WHERE role = 'PRE' AND pre_block_id = ANY(?) ORDER BY pre_block_id, id`
  ).all<{ id: number; name: string; shift: string; pre_block_id: number }>(blockIds);
  const userByBlock = new Map(preUsers.map(u => [Number(u.pre_block_id), u]));

  const floorItems: FloorOverviewItem[] = preBlocks.map(pb => {
    const wards = wardsByBlock.get(pb.id) ?? [];
    const bbGroupLabel = pb.bb_label || (pb.bb_name ? `Block ${pb.bb_name}` : null);
    return {
      floor_id: pb.id,
      building_block_id: pb.building_block_id ?? -1,
      pre: pb.name,
      floor: pb.name,
      label: bbGroupLabel ? `${bbGroupLabel} — ${pb.name}` : pb.name,
      wards,
      summary: summarize(wards),
      lastSubmittedAt: lastRoundByBlock.get(pb.id) ?? null,
      roundsToday: roundCountByBlock.get(pb.id) ?? 0,
      assignedUser: userByBlock.get(pb.id) ?? null,
    };
  });

  // Group by building_block, preserving sort order; pre_blocks with no building_block → "Other"
  const bbSeen = new Map<number | null, { name: string; sort: number }>();
  for (const pb of preBlocks) {
    const key = pb.building_block_id ?? null;
    if (!bbSeen.has(key)) {
      bbSeen.set(key, {
        name: pb.bb_label || (pb.bb_name ? `Block ${pb.bb_name}` : "Other"),
        sort: pb.bb_sort,
      });
    }
  }

  // Ensure every building_block appears even if it has no pre_blocks yet
  // (mirrors the old floor-based behaviour; lets admins see unconfigured blocks)
  const allBBs = await db.prepare(
    "SELECT id, name, label, sort_order FROM building_blocks ORDER BY sort_order, name"
  ).all<{ id: number; name: string; label: string | null; sort_order: number }>();
  for (const bb of allBBs) {
    if (!bbSeen.has(bb.id)) {
      bbSeen.set(bb.id, { name: bb.label || `Block ${bb.name}`, sort: bb.sort_order });
    }
  }

  const sortedKeys = Array.from(bbSeen.entries())
    .sort(([, a], [, b]) => a.sort - b.sort)
    .map(([k]) => k);
  const grouped = sortedKeys.map(key => ({
    name: bbSeen.get(key)!.name,
    pres: floorItems.filter(fi => (fi.building_block_id === -1 ? null : fi.building_block_id) === key),
  }));

  let v = 0, r = 0, o = 0, or_ = 0, total = 0, presReporting = 0, presTotal = 0;
  for (const item of floorItems) {
    v     += item.summary.v;
    r     += item.summary.r;
    o     += item.summary.o;
    or_   += item.summary.or;
    total += item.summary.total;
    if (item.summary.wards > 0) {
      presTotal++;
      if (item.summary.wardsDone > 0) presReporting++;
    }
  }
  return { floors: grouped, totals: { v, r, o, or: or_, total, presReporting, presTotal } };
}

// ── All-wards live overview (bypasses pre_block_wards filter) ────────────────
// Used by the admin Live Bed Dashboard so wards updated by nurses but not
// assigned to any PRE block are still visible in the counts.
export async function allWardsLive() {
  const wards = await db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total,
            w.unit_type, w.bed_type, w.room_type,
            bb.name AS block_name,
            f.name  AS floor_name,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved,
            b.updated_at AS "updatedAt",
            rv.reviewed_at AS "reviewedAt"
     FROM wards w
     JOIN beds b ON b.ward_id = w.id
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     -- "Last reviewed" = newest confirmation for any block that holds this ward,
     -- from EITHER a PRE round or a Doctor review-confirm. Unlike beds.updated_at
     -- (last value change), this moves every time a PRE/Doctor confirms the ward,
     -- even with no occupancy change.
     LEFT JOIN (
       SELECT ward_id, MAX(reviewed_at) AS reviewed_at FROM (
         SELECT pbw.ward_id, pr.submitted_at AS reviewed_at
         FROM pre_block_wards pbw
         JOIN pre_rounds pr ON pr.pre_block_id = pbw.pre_block_id
         UNION ALL
         -- Block-wide doctor reviews (ward_id NULL) fan out to every ward in the block
         SELECT dbw.ward_id, dr.reviewed_at
         FROM doctor_block_wards dbw
         JOIN doctor_block_reviews dr ON dr.doctor_block_id = dbw.doctor_block_id AND dr.ward_id IS NULL
         UNION ALL
         -- Single-ward doctor reviews apply to that ward only
         SELECT dr.ward_id, dr.reviewed_at
         FROM doctor_block_reviews dr WHERE dr.ward_id IS NOT NULL
       ) src
       GROUP BY ward_id
     ) rv ON rv.ward_id = w.id
     WHERE w.operational = true
     ORDER BY w.name`
  ).all<WardView & { bed_type: string | null; room_type: string | null; block_name: string | null; floor_name: string | null; reviewedAt: number | null }>();

  const allBedRow = await db.prepare(
    `SELECT COALESCE(SUM(total_beds),0) AS all_beds,
            COALESCE(SUM(CASE WHEN operational = false THEN total_beds ELSE 0 END),0) AS non_op_beds
     FROM wards`
  ).get<{ all_beds: number; non_op_beds: number }>();

  // Per-ward payer breakdown so the dashboard's Payer Mix can be recomputed
  // client-side from whatever wards are currently visible (Unit + Search).
  //   payersLive  = currently occupied beds by payer in that ward
  //   payersAdmit = beds taken OCCUPIED by payer, bucketed by time window
  //                 (today IST / last 7d / 30d / 12 months) for the range toggle.
  const IST = 5.5 * 3600 * 1000;
  const startOfTodayMs = Math.floor((Date.now() + IST) / 86400000) * 86400000 - IST;
  const d7Ms  = Date.now() - 7   * 86400000;
  const d30Ms = Date.now() - 30  * 86400000;
  const y1Ms  = Date.now() - 365 * 86400000;
  const wardIds = wards.map((w) => w.id);
  const [liveP, admitP] = wardIds.length === 0 ? [[], []] : await Promise.all([
    db.prepare(
      `SELECT ward_id, payer_type, COUNT(*)::int AS n FROM bed_details
        WHERE payer_type IS NOT NULL AND ward_id = ANY(?) GROUP BY ward_id, payer_type`
    ).all<{ ward_id: number; payer_type: string; n: number }>(wardIds),
    db.prepare(
      `SELECT ward_id, payer_type,
              COUNT(*) FILTER (WHERE changed_at >= ?)::int AS today,
              COUNT(*) FILTER (WHERE changed_at >= ?)::int AS d7,
              COUNT(*) FILTER (WHERE changed_at >= ?)::int AS d30,
              COUNT(*)::int                                AS y1
         FROM bed_movements
        WHERE new_physical = 'OCCUPIED' AND payer_type IS NOT NULL
          AND changed_at >= ? AND ward_id = ANY(?)
        GROUP BY ward_id, payer_type`
    ).all<{ ward_id: number; payer_type: string; today: number; d7: number; d30: number; y1: number }>(
      startOfTodayMs, d7Ms, d30Ms, y1Ms, wardIds
    ),
  ]);
  const liveByWard = new Map<number, Record<string, number>>();
  for (const row of liveP) {
    const m = liveByWard.get(row.ward_id) ?? {}; m[row.payer_type] = row.n; liveByWard.set(row.ward_id, m);
  }
  type Admit = { today: Record<string, number>; d7: Record<string, number>; d30: Record<string, number>; y1: Record<string, number> };
  const admitByWard = new Map<number, Admit>();
  for (const row of admitP) {
    const m = admitByWard.get(row.ward_id) ?? { today: {}, d7: {}, d30: {}, y1: {} };
    if (row.today) m.today[row.payer_type] = row.today;
    if (row.d7)    m.d7[row.payer_type]    = row.d7;
    if (row.d30)   m.d30[row.payer_type]   = row.d30;
    if (row.y1)    m.y1[row.payer_type]    = row.y1;
    admitByWard.set(row.ward_id, m);
  }
  for (const w of wards) {
    const wr = w as unknown as Record<string, unknown>;
    wr.payersLive  = liveByWard.get(w.id)  ?? {};
    wr.payersAdmit = admitByWard.get(w.id) ?? { today: {}, d7: {}, d30: {}, y1: {} };
  }

  let v = 0, r = 0, o = 0, or_ = 0, total = 0;
  for (const w of wards) {
    v   += w.vacant            ?? 0;
    r   += w.reserved          ?? 0;
    o   += w.occupied          ?? 0;
    or_ += w.occupied_reserved ?? 0;
    total += w.total;
  }
  return {
    wards,
    totals: { v, r, o, or: or_, total },
    allBeds:   Number(allBedRow?.all_beds   ?? total),
    nonOpBeds: Number(allBedRow?.non_op_beds ?? 0),
  };
}

export interface LiveBedDetail {
  id: number; ward_id: number; ward: string; bed_name: string;
  physical_status: string; reservation_status: string;
  payer_type: string | null; bed_type: string; unit_type: string | null;
  destination: string | null; reservation_note: string | null;
  operational_status: boolean; updated_at: number | null;
  updated_by_name: string | null;
}

// Bed-level rows for the dashboard's Bed Explorer popup (click a KPI/payer
// card to see which beds make it up). Mirrors allWardsLive's WHERE clause
// (operational wards only) so the beds returned here always add up to the
// counts shown on the cards. updated_by_name resolves to the staff member's
// name (not a doctor — this system has no patient/doctor records at all).
export async function allBedDetailsLive() {
  return db.prepare(
    `SELECT bd.id, bd.ward_id, w.name AS ward, w.unit_type, w.bed_type,
            bd.bed_name, bd.physical_status, bd.reservation_status, bd.payer_type,
            bd.destination, bd.reservation_note, bd.operational_status,
            bd.updated_at, u.name AS updated_by_name
     FROM bed_details bd
     JOIN wards w ON w.id = bd.ward_id
     LEFT JOIN users u ON u.id = bd.updated_by
     WHERE w.operational = true
     ORDER BY w.name,
       substring(bd.bed_name from '^[^0-9]*') ASC,
       NULLIF(substring(bd.bed_name from '[0-9]+'), '')::bigint NULLS LAST,
       bd.bed_name ASC`
  ).all<LiveBedDetail>();
}

export async function snapshotOccupancy() {
  const { totals } = await orgOverview();

  // Per-payer occupied-bed breakdown at this instant, so Dashboard payer cards
  // can build a real sparkline over time (no history before this column existed).
  const payerRows = await db.prepare(
    `SELECT payer_type, COUNT(*)::int AS n FROM bed_details
     WHERE physical_status='OCCUPIED' AND payer_type IS NOT NULL
     GROUP BY payer_type`
  ).all<{ payer_type: string; n: number }>();
  const payerSnapshot: Record<string, number> = {};
  for (const r of payerRows) payerSnapshot[r.payer_type] = r.n;

  await db.prepare(
    "INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied, payer_snapshot) VALUES (?,?,?,?,?,?)"
  ).run(Date.now(), totals.total, totals.v, totals.r, totals.o, JSON.stringify(payerSnapshot));
}

// ── Midnight census ──────────────────────────────────────────────────────────
// One snapshot per IST day of every ward's live counts, captured at 00:00.

export async function captureMidnightCensus(date: string): Promise<boolean> {
  const exists = await db.prepare(
    "SELECT 1 FROM midnight_census WHERE census_date=?"
  ).get(date);
  if (exists) return false;

  const wards = await db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type, w.bed_type,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w JOIN beds b ON b.ward_id = w.id ORDER BY w.name`
  ).all<WardView & { bed_type: string }>();

  await db.prepare(
    `INSERT INTO midnight_census (census_date, ts, snapshot)
     VALUES (?,?,?) ON CONFLICT (census_date) DO NOTHING`
  ).run(date, Date.now(), JSON.stringify(wards));
  return true;
}

export async function midnightCensusFor(date: string) {
  const row = await db.prepare(
    "SELECT ts, snapshot FROM midnight_census WHERE census_date=?"
  ).get<{ ts: number; snapshot: string }>(date);
  if (!row) return null;
  let wards: unknown[] = [];
  try { wards = JSON.parse(row.snapshot || "[]"); } catch { /* corrupt row */ }
  return { ts: row.ts, wards };
}

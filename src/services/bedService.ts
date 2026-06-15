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
      "INSERT INTO bed_status_updates (ward_id, vacant_none, vacant_reserved, occupied_none, occupied_reserved, updated_by, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run(wardId, vn, vr, on_, or_, userId, now);
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
            b.updated_at AS "updatedAt"
     FROM wards w
     JOIN beds b ON b.ward_id = w.id
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     WHERE w.operational = true
     ORDER BY w.name`
  ).all<WardView & { bed_type: string | null; room_type: string | null; block_name: string | null; floor_name: string | null }>();

  const allBedRow = await db.prepare(
    `SELECT COALESCE(SUM(total_beds),0) AS all_beds,
            COALESCE(SUM(CASE WHEN operational = false THEN total_beds ELSE 0 END),0) AS non_op_beds
     FROM wards`
  ).get<{ all_beds: number; non_op_beds: number }>();

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

export async function snapshotOccupancy() {
  const { totals } = await orgOverview();
  await db.prepare(
    "INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied) VALUES (?,?,?,?,?)"
  ).run(Date.now(), totals.total, totals.v, totals.r, totals.o);
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
            b.vacant, b.reserved, b.occupied, b.updated_at AS "updatedAt"
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

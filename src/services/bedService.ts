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
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     WHERE pbw.pre_block_id = ? ORDER BY w.name`
  ).all<WardView>(preBlockId);
}

export function summarize(wards: WardView[]): PreSummary {
  let v = 0, r = 0, o = 0, or_ = 0, total = 0, wardsDone = 0;
  for (const w of wards) {
    total += w.total;
    if (w.vacant !== null) {
      wardsDone++;
      v  += w.vacant            || 0;
      r  += w.reserved          || 0;
      o  += w.occupied          || 0;
      or_ += w.occupied_reserved || 0;
    }
  }
  return { v, r, o, or: or_, total, wards: wards.length, wardsDone,
           complete: wards.length > 0 && wardsDone === wards.length };
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

  const vn = Math.max(0, Math.floor(vacantNone));
  const vr = Math.max(0, Math.floor(vacantReserved));
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
    ward: ward.name, vacant_none: vn, vacant_reserved: vr,
    occupied_none: on_, occupied_reserved: or_,
  });
  return { ward: ward.name, vacant: vn, reserved: vr, occupied: on_, occupied_reserved: or_, total: ward.total };
}

interface FloorOverviewItem {
  floor_id: number;
  building_block_id: number;
  pre: string;          // display name used throughout (e.g. "A - Ground Floor")
  floor: string;        // alias for pre
  label: string;        // longer label
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
  const buildingBlocks = await db.prepare(
    "SELECT id, name, label, sort_order FROM building_blocks ORDER BY sort_order, name"
  ).all<{ id: number; name: string; label: string | null; sort_order: number }>();

  const allFloors = await db.prepare(
    "SELECT id, name, building_block_id, sort_order FROM floors ORDER BY sort_order, name"
  ).all<{ id: number; name: string; building_block_id: number; sort_order: number }>();

  const today = startOfDayIST();

  const floorItems: FloorOverviewItem[] = await Promise.all(allFloors.map(async floor => {
    const bb = buildingBlocks.find(b => b.id === floor.building_block_id);
    const displayName = bb ? `${bb.name} - ${floor.name}` : floor.name;
    const wards = await wardsForFloor(floor.id);
    const last = await db.prepare(
      "SELECT submitted_at FROM pre_rounds WHERE floor_id=? ORDER BY submitted_at DESC LIMIT 1"
    ).get<{ submitted_at: number }>(floor.id);
    const roundsRow = await db.prepare(
      "SELECT COUNT(*) AS c FROM pre_rounds WHERE floor_id=? AND submitted_at>=?"
    ).get<{ c: number }>(floor.id, today);
    const assignedUser = await db.prepare(
      "SELECT id, name, shift FROM users WHERE floor_id=? AND role='PRE' LIMIT 1"
    ).get<{ id: number; name: string; shift: string }>(floor.id) ?? null;

    return {
      floor_id: floor.id,
      building_block_id: floor.building_block_id,
      pre: displayName,
      floor: displayName,
      label: `${bb ? (bb.label || `Block ${bb.name}`) : ''} — ${floor.name}`,
      wards,
      summary: summarize(wards),
      lastSubmittedAt: last?.submitted_at ?? null,
      roundsToday: roundsRow?.c ?? 0,
      assignedUser,
    };
  }));

  // Group floor items by building block
  const grouped = buildingBlocks.map(bb => ({
    name: bb.label || `Block ${bb.name}`,
    pres: floorItems.filter(fi => fi.building_block_id === bb.id),
  }));

  let v = 0, r = 0, o = 0, or_ = 0, total = 0, presReporting = 0, presTotal = 0;
  for (const item of floorItems) {
    v  += item.summary.v;
    r  += item.summary.r;
    o  += item.summary.o;
    or_ += item.summary.or;
    total += item.summary.total;
    if (item.summary.wards > 0) {
      presTotal++;
      if (item.summary.wardsDone > 0) presReporting++;
    }
  }
  return { floors: grouped, totals: { v, r, o, or: or_, total, presReporting, presTotal } };
}

export async function snapshotOccupancy() {
  const { totals } = await orgOverview();
  await db.prepare(
    "INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied) VALUES (?,?,?,?,?)"
  ).run(Date.now(), totals.total, totals.v + totals.r, totals.r + totals.or, totals.o + totals.or);
}

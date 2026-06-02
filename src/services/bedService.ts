import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { startOfDayIST } from "../config/domain.js";

export interface WardView {
  id: number; ward: string; total: number;
  vacant: number | null; reserved: number | null; occupied: number | null;
  updatedAt: number | null;
}

export interface PreSummary {
  v: number; o: number; r: number; total: number;
  wards: number; wardsDone: number; complete: boolean;
}

export async function wardsForBlock(blockId: number): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total,
            b.vacant, b.reserved, b.occupied, b.updated_at AS "updatedAt"
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.block_id = ? ORDER BY w.name`
  ).all<WardView>(blockId);
}

export function summarize(wards: WardView[]): PreSummary {
  let v = 0, o = 0, r = 0, total = 0, wardsDone = 0;
  for (const w of wards) {
    total += w.total;
    if (w.vacant !== null) {
      wardsDone++; v += w.vacant; o += w.occupied || 0; r += w.reserved || 0;
    }
  }
  return { v, o, r, total, wards: wards.length, wardsDone,
           complete: wards.length > 0 && wardsDone === wards.length };
}

export async function updateWard(wardId: number, vacant: number, reserved: number, userId: number) {
  const ward = await db.prepare(
    "SELECT id, name, total_beds AS total, block_id FROM wards WHERE id = ?"
  ).get<{ id: number; name: string; total: number; block_id: number }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");

  const v = Math.max(0, Math.floor(vacant));
  const r = Math.max(0, Math.floor(reserved));
  if (v + r > ward.total) throw new HttpError(400, `Vacant + reserved exceed ${ward.total} beds`);
  const occupied = ward.total - v - r;
  const now = Date.now();

  await db.transaction(async () => {
    await db.prepare(
      "UPDATE beds SET vacant=?, reserved=?, occupied=?, updated_at=?, updated_by=? WHERE ward_id=?"
    ).run(v, r, occupied, now, userId, wardId);
    await db.prepare(
      "INSERT INTO bed_status_updates (ward_id, vacant, reserved, occupied, updated_by, created_at) VALUES (?,?,?,?,?,?)"
    ).run(wardId, v, r, occupied, userId, now);
  });

  const blockName = (await db.prepare("SELECT name FROM blocks WHERE id = ?")
    .get<{ name: string }>(ward.block_id))?.name ?? String(ward.block_id);
  await audit(userId, "ward_update", blockName, { ward: ward.name, vacant: v, reserved: r, occupied });
  return { ward: ward.name, vacant: v, reserved: r, occupied, total: ward.total };
}

interface BlockOverviewItem {
  block_id: number; pre: string; floor: string; label: string;
  wards: WardView[]; summary: PreSummary;
  lastSubmittedAt: number | null; roundsToday: number;
  assignedUser: { id: number; name: string; shift: string } | null;
}

export async function orgOverview(): Promise<{
  floors: { name: string; pres: BlockOverviewItem[] }[];
  totals: { v: number; o: number; r: number; total: number; presReporting: number; presTotal: number };
}> {
  const blocks = await db.prepare(
    "SELECT id, name, label, sort_order FROM blocks ORDER BY sort_order, name"
  ).all<{ id: number; name: string; label: string | null; sort_order: number }>();

  const today = startOfDayIST();

  const items: BlockOverviewItem[] = await Promise.all(blocks.map(async block => {
    const wards = await wardsForBlock(block.id);
    const last  = await db.prepare(
      "SELECT submitted_at FROM pre_rounds WHERE block_id=? ORDER BY submitted_at DESC LIMIT 1"
    ).get<{ submitted_at: number }>(block.id);
    const roundsRow = await db.prepare(
      "SELECT COUNT(*) AS c FROM pre_rounds WHERE block_id=? AND submitted_at>=?"
    ).get<{ c: number }>(block.id, today);
    const assignedUser = await db.prepare(
      "SELECT id, name, shift FROM users WHERE block_id=? AND role='PRE' LIMIT 1"
    ).get<{ id: number; name: string; shift: string }>(block.id) ?? null;

    return {
      block_id: block.id, pre: block.name, floor: block.name,
      label: block.label || block.name, wards,
      summary: summarize(wards),
      lastSubmittedAt: last?.submitted_at ?? null,
      roundsToday: roundsRow?.c ?? 0,
      assignedUser,
    };
  }));

  const floors = items.map(item => ({ name: item.pre, pres: [item] }));
  let v = 0, o = 0, r = 0, total = 0, presReporting = 0, presTotal = 0;
  for (const item of items) {
    v += item.summary.v; o += item.summary.o;
    r += item.summary.r; total += item.summary.total;
    if (item.summary.wards > 0) {
      presTotal++;
      if (item.summary.wardsDone > 0) presReporting++;
    }
  }
  return { floors, totals: { v, o, r, total, presReporting, presTotal } };
}

export async function snapshotOccupancy() {
  const { totals } = await orgOverview();
  await db.prepare(
    "INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied) VALUES (?,?,?,?,?)"
  ).run(Date.now(), totals.total, totals.v, totals.r, totals.o);
}

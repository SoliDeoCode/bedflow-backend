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

export function wardsForPre(preCode: string): WardView[] {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total,
            b.vacant, b.reserved, b.occupied, b.updated_at AS updatedAt
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.pre_code = ? ORDER BY w.name`
  ).all<WardView>(preCode);
}

export function summarize(wards: WardView[]): PreSummary {
  let v = 0, o = 0, r = 0, total = 0, wardsDone = 0;
  for (const w of wards) {
    total += w.total;
    if (w.vacant !== null) { wardsDone++; v += w.vacant; o += w.occupied || 0; r += w.reserved || 0; }
  }
  return { v, o, r, total, wards: wards.length, wardsDone, complete: wards.length > 0 && wardsDone === wards.length };
}

// Auto-calculation rule: caller provides vacant + reserved; occupied is derived.
export function updateWard(wardId: number, vacant: number, reserved: number, userId: number) {
  const ward = db.prepare("SELECT id, name, total_beds AS total, pre_code FROM wards WHERE id = ?")
    .get<{ id: number; name: string; total: number; pre_code: string }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  const v = Math.max(0, Math.floor(vacant));
  const r = Math.max(0, Math.floor(reserved));
  if (v + r > ward.total) throw new HttpError(400, `Vacant + reserved exceed ${ward.total} beds`);
  const occupied = ward.total - v - r;
  const now = Date.now();

  db.transaction(() => {
    db.prepare("UPDATE beds SET vacant=?, reserved=?, occupied=?, updated_at=?, updated_by=? WHERE ward_id=?")
      .run(v, r, occupied, now, userId, wardId);
    db.prepare("INSERT INTO bed_status_updates (ward_id, vacant, reserved, occupied, updated_by, created_at) VALUES (?,?,?,?,?,?)")
      .run(wardId, v, r, occupied, userId, now);
  });
  audit(userId, "ward_update", ward.pre_code, { ward: ward.name, vacant: v, reserved: r, occupied });
  return { ward: ward.name, vacant: v, reserved: r, occupied, total: ward.total };
}

// Build the floor → PRE structure dynamically from the database, so wards/PREs
// created by the Manager show up without code changes. Falls back to listing
// any pre_code that has wards even if its floor is unset.
export function floorStructure(): { name: string; pres: string[] }[] {
  // floors that have at least one ward, ordered
  const rows = db.prepare(
    `SELECT DISTINCT COALESCE(f.name, 'Unassigned') AS floor, w.pre_code AS pre, f.id AS fid
     FROM wards w LEFT JOIN floors f ON f.id = w.floor_id`
  ).all<{ floor: string; pre: string; fid: number | null }>();
  // also include PREs that exist via assignment but have no wards yet
  const assigned = db.prepare(
    `SELECT DISTINCT a.pre_code AS pre FROM pre_assignments a`
  ).all<{ pre: string }>();

  const byFloor = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byFloor.has(r.floor)) byFloor.set(r.floor, new Set());
    byFloor.get(r.floor)!.add(r.pre);
  }
  // place assignment-only PREs (no wards) under 'Unassigned'
  const known = new Set(rows.map((r) => r.pre));
  for (const a of assigned) {
    if (!known.has(a.pre)) {
      if (!byFloor.has("Unassigned")) byFloor.set("Unassigned", new Set());
      byFloor.get("Unassigned")!.add(a.pre);
    }
  }
  // stable ordering: floor name, then pre code numeric
  const order = (p: string) => parseInt(p.replace(/\D/g, "") || "999", 10);
  return [...byFloor.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, set]) => ({ name, pres: [...set].sort((a, b) => order(a) - order(b)) }));
}

// Hospital-wide view grouped by floor → PRE, for the COO dashboard.
export function orgOverview() {
  const floors = floorStructure().map(({ name, pres }) => ({
    name,
    pres: pres.map((pre) => {
      const wards = wardsForPre(pre);
      const last = db.prepare("SELECT submitted_at FROM pre_rounds WHERE pre_code=? ORDER BY submitted_at DESC LIMIT 1")
        .get<{ submitted_at: number }>(pre);
      // today's round count
      // Use IST midnight so rounds-today count is correct on Render (UTC server).
      const roundsToday = db.prepare("SELECT COUNT(*) AS c FROM pre_rounds WHERE pre_code=? AND submitted_at>=?")
        .get<{ c: number }>(pre, startOfDayIST())?.c ?? 0;
      return {
        pre, wards, summary: summarize(wards),
        floor: name, label: pre.replace("PRE-", "Premium "),
        lastSubmittedAt: last?.submitted_at ?? null, roundsToday,
      };
    }),
  }));
  let v = 0, o = 0, r = 0, total = 0, presReporting = 0, presTotal = 0;
  for (const f of floors) for (const p of f.pres) {
    v += p.summary.v; o += p.summary.o; r += p.summary.r; total += p.summary.total;
    if (p.summary.wards > 0) { presTotal++; if (p.summary.wardsDone > 0) presReporting++; }
  }
  return { floors, totals: { v, o, r, total, presReporting, presTotal } };
}

export function snapshotOccupancy() {
  const { totals } = orgOverview();
  db.prepare("INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied) VALUES (?,?,?,?,?)")
    .run(Date.now(), totals.total, totals.v, totals.r, totals.o);
}

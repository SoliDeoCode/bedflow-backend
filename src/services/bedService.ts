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

// Build the floor → PRE structure dynamically from the database.
// FIX: normalises floor names (TRIM+LOWER) so "1st Floor" and "1st floor "
// collapse to the same bucket.  Each PRE is placed on exactly ONE floor:
// any named floor beats Unassigned, so a PRE whose ward just lost its
// floor_id doesn't ghost into Unassigned while still appearing on its real floor.
export function floorStructure(): { name: string; pres: string[] }[] {
  // Collect all (pre_code, normalised_key, trimmed_display) pairs from wards.
  const rows = db.prepare(
    `SELECT DISTINCT
       w.pre_code                         AS pre,
       TRIM(LOWER(COALESCE(f.name, '')))  AS floor_key,
       TRIM(COALESCE(f.name, ''))         AS floor_disp
     FROM wards w LEFT JOIN floors f ON f.id = w.floor_id`
  ).all<{ pre: string; floor_key: string; floor_disp: string }>();

  // For each PRE: exactly one floor entry.
  // Rule: a real (non-empty) floor name wins over a NULL/Unassigned one.
  const preToFloor = new Map<string, { key: string; disp: string }>();
  for (const row of rows) {
    const cur = preToFloor.get(row.pre);
    if (!cur || (cur.key === '' && row.floor_key !== '')) {
      preToFloor.set(row.pre, { key: row.floor_key, disp: row.floor_disp });
    }
  }

  // PREs that have a user assignment but zero wards go to Unassigned.
  const assigned = db.prepare(
    `SELECT DISTINCT a.pre_code AS pre FROM pre_assignments a`
  ).all<{ pre: string }>();
  for (const a of assigned) {
    if (!preToFloor.has(a.pre)) preToFloor.set(a.pre, { key: '', disp: '' });
  }

  // Group by normalised key — merges "1st Floor" / "1st floor " / "1ST FLOOR" etc.
  const byFloor = new Map<string, { disp: string; pres: Set<string> }>();
  for (const [pre, { key, disp }] of preToFloor) {
    const gKey  = key  || 'unassigned';
    const gDisp = disp || 'Unassigned';
    if (!byFloor.has(gKey)) byFloor.set(gKey, { disp: gDisp, pres: new Set() });
    byFloor.get(gKey)!.pres.add(pre);
  }

  const order = (p: string) => parseInt(p.replace(/\D/g, '') || '999', 10);
  return [...byFloor.values()]
    .sort((a, b) => a.disp.localeCompare(b.disp))
    .map(({ disp, pres }) => ({
      name: disp,
      pres: [...pres].sort((a, b) => order(a) - order(b)),
    }));
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
  // FIX: deduplicate PREs before summing so a PRE that somehow appears in two
  // floor buckets (legacy data race) is not counted twice.
  let v = 0, o = 0, r = 0, total = 0, presReporting = 0, presTotal = 0;
  const counted = new Set<string>();
  for (const f of floors) for (const p of f.pres) {
    if (counted.has(p.pre)) continue;
    counted.add(p.pre);
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

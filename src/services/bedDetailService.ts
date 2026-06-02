import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

// Must be called inside an existing db.transaction() — never opens its own.
//
// bed_details is now the source of truth for both bed STATUS (vacant/reserved/
// occupied) and bed CAPACITY (total). This function rebuilds the legacy summary
// rows (beds.* and wards.total_beds) from bed_details so the Manager Blocks page
// and any other consumer reading the old columns stays in sync automatically.
export function _recalcWardTotals(wardId: number) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='VACANT'   THEN 1 ELSE 0 END) AS vacant,
      SUM(CASE WHEN status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status='OCCUPIED' THEN 1 ELSE 0 END) AS occupied
    FROM bed_details WHERE ward_id = ?
  `).get<{ total: number; vacant: number; reserved: number; occupied: number }>(wardId);
  if (!counts) return;
  // Math.max(0, ...) is belt-and-braces; COUNT(*) is always ≥ 0, but the schema's
  // CHECK (total_beds >= 0) constraint would otherwise throw if anything regressed.
  const total = Math.max(0, counts.total || 0);
  const now = Date.now();
  db.prepare(
    "UPDATE beds SET total=?, vacant=?, reserved=?, occupied=?, updated_at=? WHERE ward_id=?"
  ).run(total, counts.vacant || 0, counts.reserved || 0, counts.occupied || 0, now, wardId);
  db.prepare(
    "UPDATE wards SET total_beds=?, updated_at=? WHERE id=?"
  ).run(total, now, wardId);
}

export function generateBeds(opts: {
  wardId: number; startNumber: number; count: number; userId: number;
}) {
  if (!db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
    throw new HttpError(404, "Ward not found");
  if (opts.count < 1 || opts.count > 500)
    throw new HttpError(400, "Count must be between 1 and 500");

  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO bed_details (ward_id, bed_number, status, updated_at, updated_by) VALUES (?,?,?,?,?)"
  );
  let inserted = 0;
  db.transaction(() => {
    for (let i = 0; i < opts.count; i++) {
      const r = ins.run(opts.wardId, String(opts.startNumber + i), "VACANT", now, opts.userId);
      inserted += r.changes;
    }
    _recalcWardTotals(opts.wardId);
  });

  audit(opts.userId, "beds_generate", String(opts.wardId),
    { startNumber: opts.startNumber, count: opts.count, inserted });
  return { ok: true, generated: inserted };
}

export function addSingleBed(opts: {
  wardId: number; bedNumber: string; userId: number;
}) {
  if (!db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
    throw new HttpError(404, "Ward not found");

  const trimmed = opts.bedNumber.trim();
  if (!trimmed) throw new HttpError(400, "Bed number required");

  const now = Date.now();
  let newId = 0;
  db.transaction(() => {
    const existing = db.prepare(
      "SELECT id FROM bed_details WHERE ward_id=? AND bed_number=?"
    ).get(opts.wardId, trimmed);
    if (existing) throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);

    const r = db.prepare(
      "INSERT INTO bed_details (ward_id, bed_number, status, updated_at, updated_by) VALUES (?,?,?,?,?)"
    ).run(opts.wardId, trimmed, "VACANT", now, opts.userId);
    newId = Number(r.lastInsertRowid);
    _recalcWardTotals(opts.wardId);
  });

  audit(opts.userId, "bed_add", String(opts.wardId), { bedNumber: trimmed });
  return { ok: true, id: newId };
}

export interface BedDetail {
  id: number;
  ward_id: number;
  bed_number: string;
  status: string;
  updated_at: number;
  updated_by: number | null;
}

export function listBeds(wardId: number, status?: string): BedDetail[] {
  const valid = ["VACANT", "RESERVED", "OCCUPIED"];
  const upper = status?.toUpperCase();
  if (upper && !valid.includes(upper)) throw new HttpError(400, "Invalid status filter");

  let sql =
    "SELECT id, ward_id, bed_number, status, updated_at, updated_by " +
    "FROM bed_details WHERE ward_id=?";
  const params: unknown[] = [wardId];
  if (upper) { sql += " AND status=?"; params.push(upper); }
  // Sort numerically where possible, then lexicographically
  sql += " ORDER BY CAST(bed_number AS INTEGER), bed_number";

  return db.prepare(sql).all<BedDetail>(...params);
}

export function renameBed(opts: {
  bedId: number; newBedNumber: string; userId: number;
}) {
  const bed = db.prepare(
    "SELECT id, ward_id, bed_number FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_number: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  const trimmed = opts.newBedNumber.trim();
  if (!trimmed) throw new HttpError(400, "Bed number required");
  if (trimmed === bed.bed_number) return { ok: true };

  const clash = db.prepare(
    "SELECT 1 FROM bed_details WHERE ward_id=? AND bed_number=? AND id!=?"
  ).get(bed.ward_id, trimmed, opts.bedId);
  if (clash) throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);

  db.prepare("UPDATE bed_details SET bed_number=?, updated_at=? WHERE id=?")
    .run(trimmed, Date.now(), opts.bedId);

  audit(opts.userId, "bed_rename", String(opts.bedId),
    { from: bed.bed_number, to: trimmed });
  return { ok: true };
}

export function deleteBed(opts: { bedId: number; userId: number }) {
  const bed = db.prepare(
    "SELECT id, ward_id, bed_number FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_number: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  db.transaction(() => {
    db.prepare("DELETE FROM bed_details WHERE id=?").run(opts.bedId);
    _recalcWardTotals(bed.ward_id);
  });

  audit(opts.userId, "bed_delete", String(opts.bedId),
    { bedNumber: bed.bed_number, wardId: bed.ward_id });
  return { ok: true };
}

export function updateBedStatus(opts: {
  bedId: number; newStatus: string; userId: number;
}) {
  const bed = db.prepare(
    "SELECT id, ward_id, status FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; status: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  const valid = ["VACANT", "RESERVED", "OCCUPIED"];
  if (!valid.includes(opts.newStatus)) throw new HttpError(400, "Invalid status");
  if (bed.status === opts.newStatus) return { ok: true, status: opts.newStatus };

  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "UPDATE bed_details SET status=?, updated_at=?, updated_by=? WHERE id=?"
    ).run(opts.newStatus, now, opts.userId, opts.bedId);
    db.prepare(
      "INSERT INTO bed_movements (bed_id, old_status, new_status, changed_by, changed_at) VALUES (?,?,?,?,?)"
    ).run(opts.bedId, bed.status, opts.newStatus, opts.userId, now);
    _recalcWardTotals(bed.ward_id);
  });

  audit(opts.userId, "bed_status_update", String(opts.bedId),
    { old: bed.status, new: opts.newStatus, wardId: bed.ward_id });
  return { ok: true, status: opts.newStatus };
}

import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

export async function _recalcWardTotals(wardId: number) {
  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='VACANT'   THEN 1 ELSE 0 END) AS vacant,
      SUM(CASE WHEN status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status='OCCUPIED' THEN 1 ELSE 0 END) AS occupied
    FROM bed_details WHERE ward_id = ?
  `).get<{ total: number; vacant: number; reserved: number; occupied: number }>(wardId);
  if (!counts) return;
  const total = Math.max(0, counts.total || 0);
  const now = Date.now();
  await db.prepare(
    "UPDATE beds SET total=?, vacant=?, reserved=?, occupied=?, updated_at=? WHERE ward_id=?"
  ).run(total, counts.vacant || 0, counts.reserved || 0, counts.occupied || 0, now, wardId);
  await db.prepare(
    "UPDATE wards SET total_beds=?, updated_at=? WHERE id=?"
  ).run(total, now, wardId);
}

export async function generateBeds(opts: {
  wardId: number; startNumber: number; count: number; userId: number;
}) {
  if (!await db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
    throw new HttpError(404, "Ward not found");
  if (opts.count < 1 || opts.count > 500)
    throw new HttpError(400, "Count must be between 1 and 500");

  const now = Date.now();
  let inserted = 0;
  await db.transaction(async () => {
    for (let i = 0; i < opts.count; i++) {
      // ON CONFLICT DO NOTHING replaces SQLite's INSERT OR IGNORE
      const r = await db.prepare(
        "INSERT INTO bed_details (ward_id, bed_number, status, updated_at, updated_by) VALUES (?,?,?,?,?) ON CONFLICT (ward_id, bed_number) DO NOTHING"
      ).run(opts.wardId, String(opts.startNumber + i), "VACANT", now, opts.userId);
      inserted += r.changes;
    }
    await _recalcWardTotals(opts.wardId);
  });

  await audit(opts.userId, "beds_generate", String(opts.wardId),
    { startNumber: opts.startNumber, count: opts.count, inserted });
  return { ok: true, generated: inserted };
}

export async function addSingleBed(opts: {
  wardId: number; bedNumber: string; userId: number;
}) {
  if (!await db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
    throw new HttpError(404, "Ward not found");

  const trimmed = opts.bedNumber.trim();
  if (!trimmed) throw new HttpError(400, "Bed number required");

  const now = Date.now();
  let newId = 0;
  await db.transaction(async () => {
    const existing = await db.prepare(
      "SELECT id FROM bed_details WHERE ward_id=? AND bed_number=?"
    ).get(opts.wardId, trimmed);
    if (existing) throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);

    // RETURNING id so lastInsertRowid works in PostgreSQL
    const r = await db.prepare(
      "INSERT INTO bed_details (ward_id, bed_number, status, updated_at, updated_by) VALUES (?,?,?,?,?) RETURNING id"
    ).run(opts.wardId, trimmed, "VACANT", now, opts.userId);
    newId = Number(r.lastInsertRowid);
    await _recalcWardTotals(opts.wardId);
  });

  await audit(opts.userId, "bed_add", String(opts.wardId), { bedNumber: trimmed });
  return { ok: true, id: newId };
}

export interface BedDetail {
  id: number; ward_id: number; bed_number: string;
  status: string; updated_at: number; updated_by: number | null;
}

export async function listBeds(wardId: number, status?: string): Promise<BedDetail[]> {
  const valid = ["VACANT", "RESERVED", "OCCUPIED"];
  const upper = status?.toUpperCase();
  if (upper && !valid.includes(upper)) throw new HttpError(400, "Invalid status filter");

  let sql =
    "SELECT id, ward_id, bed_number, status, updated_at, updated_by " +
    "FROM bed_details WHERE ward_id=?";
  const params: unknown[] = [wardId];
  if (upper) { sql += " AND status=?"; params.push(upper); }
  sql += " ORDER BY CAST(bed_number AS INTEGER), bed_number";

  return db.prepare(sql).all<BedDetail>(...params);
}

export async function renameBed(opts: {
  bedId: number; newBedNumber: string; userId: number;
}) {
  const bed = await db.prepare(
    "SELECT id, ward_id, bed_number FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_number: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  const trimmed = opts.newBedNumber.trim();
  if (!trimmed) throw new HttpError(400, "Bed number required");
  if (trimmed === bed.bed_number) return { ok: true };

  const clash = await db.prepare(
    "SELECT 1 FROM bed_details WHERE ward_id=? AND bed_number=? AND id!=?"
  ).get(bed.ward_id, trimmed, opts.bedId);
  if (clash) throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);

  await db.prepare("UPDATE bed_details SET bed_number=?, updated_at=? WHERE id=?")
    .run(trimmed, Date.now(), opts.bedId);

  await audit(opts.userId, "bed_rename", String(opts.bedId),
    { from: bed.bed_number, to: trimmed });
  return { ok: true };
}

export async function deleteBed(opts: { bedId: number; userId: number }) {
  const bed = await db.prepare(
    "SELECT id, ward_id, bed_number FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_number: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  await db.transaction(async () => {
    await db.prepare("DELETE FROM bed_details WHERE id=?").run(opts.bedId);
    await _recalcWardTotals(bed.ward_id);
  });

  await audit(opts.userId, "bed_delete", String(opts.bedId),
    { bedNumber: bed.bed_number, wardId: bed.ward_id });
  return { ok: true };
}

export async function updateBedStatus(opts: {
  bedId: number; newStatus: string; userId: number;
}) {
  const bed = await db.prepare(
    "SELECT id, ward_id, status FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; status: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  const valid = ["VACANT", "RESERVED", "OCCUPIED"];
  if (!valid.includes(opts.newStatus)) throw new HttpError(400, "Invalid status");
  if (bed.status === opts.newStatus) return { ok: true, status: opts.newStatus };

  const now = Date.now();
  await db.transaction(async () => {
    await db.prepare(
      "UPDATE bed_details SET status=?, updated_at=?, updated_by=? WHERE id=?"
    ).run(opts.newStatus, now, opts.userId, opts.bedId);
    await db.prepare(
      "INSERT INTO bed_movements (bed_id, old_status, new_status, changed_by, changed_at) VALUES (?,?,?,?,?)"
    ).run(opts.bedId, bed.status, opts.newStatus, opts.userId, now);
    await _recalcWardTotals(bed.ward_id);
  });

  await audit(opts.userId, "bed_status_update", String(opts.bedId),
    { old: bed.status, new: opts.newStatus, wardId: bed.ward_id });
  return { ok: true, status: opts.newStatus };
}

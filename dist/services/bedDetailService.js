import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
export async function _recalcWardTotals(wardId) {
    const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN physical_status='VACANT'   AND reservation_status='NONE'     THEN 1 ELSE 0 END) AS vacant,
      SUM(CASE WHEN physical_status='VACANT'   AND reservation_status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN physical_status='OCCUPIED' AND reservation_status='NONE'     THEN 1 ELSE 0 END) AS occupied,
      SUM(CASE WHEN physical_status='OCCUPIED' AND reservation_status='RESERVED' THEN 1 ELSE 0 END) AS occupied_reserved
    FROM bed_details WHERE ward_id = ?
  `).get(wardId);
    if (!counts)
        return;
    const total = Math.max(0, counts.total || 0);
    const now = Date.now();
    await db.prepare("UPDATE beds SET total=?, vacant=?, reserved=?, occupied=?, occupied_reserved=?, updated_at=? WHERE ward_id=?").run(total, counts.vacant || 0, counts.reserved || 0, counts.occupied || 0, counts.occupied_reserved || 0, now, wardId);
    await db.prepare("UPDATE wards SET total_beds=?, updated_at=? WHERE id=?").run(total, now, wardId);
}
export async function generateBeds(opts) {
    if (!await db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
        throw new HttpError(404, "Ward not found");
    if (opts.count < 1 || opts.count > 500)
        throw new HttpError(400, "Count must be between 1 and 500");
    const now = Date.now();
    let inserted = 0;
    await db.transaction(async () => {
        for (let i = 0; i < opts.count; i++) {
            const r = await db.prepare("INSERT INTO bed_details (ward_id, bed_number, physical_status, reservation_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?) ON CONFLICT (ward_id, bed_number) DO NOTHING").run(opts.wardId, String(opts.startNumber + i), now, opts.userId);
            inserted += r.changes;
        }
        await _recalcWardTotals(opts.wardId);
    });
    await audit(opts.userId, "beds_generate", String(opts.wardId), { startNumber: opts.startNumber, count: opts.count, inserted });
    return { ok: true, generated: inserted };
}
export async function addSingleBed(opts) {
    if (!await db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
        throw new HttpError(404, "Ward not found");
    const trimmed = opts.bedNumber.trim();
    if (!trimmed)
        throw new HttpError(400, "Bed number required");
    const now = Date.now();
    let newId = 0;
    await db.transaction(async () => {
        const existing = await db.prepare("SELECT id FROM bed_details WHERE ward_id=? AND bed_number=?").get(opts.wardId, trimmed);
        if (existing)
            throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);
        // RETURNING id so lastInsertRowid works in PostgreSQL
        const r = await db.prepare("INSERT INTO bed_details (ward_id, bed_number, physical_status, reservation_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?) RETURNING id").run(opts.wardId, trimmed, now, opts.userId);
        newId = Number(r.lastInsertRowid);
        await _recalcWardTotals(opts.wardId);
    });
    await audit(opts.userId, "bed_add", String(opts.wardId), { bedNumber: trimmed });
    return { ok: true, id: newId };
}
export async function listBeds(wardId, physicalStatus, reservationStatus) {
    let sql = "SELECT id, ward_id, bed_number, physical_status, reservation_status, updated_at, updated_by FROM bed_details WHERE ward_id=?";
    const params = [wardId];
    if (physicalStatus) {
        const validPhysical = ["VACANT", "OCCUPIED"];
        if (!validPhysical.includes(physicalStatus.toUpperCase()))
            throw new HttpError(400, "Invalid physical_status filter");
        sql += " AND physical_status=?";
        params.push(physicalStatus.toUpperCase());
    }
    if (reservationStatus) {
        const validReservation = ["NONE", "RESERVED"];
        if (!validReservation.includes(reservationStatus.toUpperCase()))
            throw new HttpError(400, "Invalid reservation_status filter");
        sql += " AND reservation_status=?";
        params.push(reservationStatus.toUpperCase());
    }
    sql += " ORDER BY CAST(bed_number AS INTEGER), bed_number";
    return db.prepare(sql).all(...params);
}
export async function renameBed(opts) {
    const bed = await db.prepare("SELECT id, ward_id, bed_number FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    const trimmed = opts.newBedNumber.trim();
    if (!trimmed)
        throw new HttpError(400, "Bed number required");
    if (trimmed === bed.bed_number)
        return { ok: true };
    const clash = await db.prepare("SELECT 1 FROM bed_details WHERE ward_id=? AND bed_number=? AND id!=?").get(bed.ward_id, trimmed, opts.bedId);
    if (clash)
        throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);
    await db.prepare("UPDATE bed_details SET bed_number=?, updated_at=? WHERE id=?")
        .run(trimmed, Date.now(), opts.bedId);
    await audit(opts.userId, "bed_rename", String(opts.bedId), { from: bed.bed_number, to: trimmed });
    return { ok: true };
}
export async function deleteBed(opts) {
    const bed = await db.prepare("SELECT id, ward_id, bed_number FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    await db.transaction(async () => {
        await db.prepare("DELETE FROM bed_details WHERE id=?").run(opts.bedId);
        await _recalcWardTotals(bed.ward_id);
    });
    await audit(opts.userId, "bed_delete", String(opts.bedId), { bedNumber: bed.bed_number, wardId: bed.ward_id });
    return { ok: true };
}
export async function updateBedStatus(opts) {
    const bed = await db.prepare("SELECT id, ward_id, physical_status, reservation_status FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    const validPhysical = ["VACANT", "OCCUPIED"];
    const validReservation = ["NONE", "RESERVED"];
    if (!validPhysical.includes(opts.physicalStatus))
        throw new HttpError(400, "Invalid physical_status");
    if (!validReservation.includes(opts.reservationStatus))
        throw new HttpError(400, "Invalid reservation_status");
    if (bed.physical_status === opts.physicalStatus && bed.reservation_status === opts.reservationStatus)
        return { ok: true, physical_status: opts.physicalStatus, reservation_status: opts.reservationStatus };
    const now = Date.now();
    await db.transaction(async () => {
        await db.prepare("UPDATE bed_details SET physical_status=?, reservation_status=?, updated_at=?, updated_by=? WHERE id=?").run(opts.physicalStatus, opts.reservationStatus, now, opts.userId, opts.bedId);
        await db.prepare("INSERT INTO bed_movements (bed_id, old_physical, new_physical, old_reservation, new_reservation, changed_by, changed_at) VALUES (?,?,?,?,?,?,?)").run(opts.bedId, bed.physical_status, opts.physicalStatus, bed.reservation_status, opts.reservationStatus, opts.userId, now);
        await _recalcWardTotals(bed.ward_id);
    });
    await audit(opts.userId, "bed_status_update", String(opts.bedId), {
        old: { physical: bed.physical_status, reservation: bed.reservation_status },
        new: { physical: opts.physicalStatus, reservation: opts.reservationStatus },
        wardId: bed.ward_id,
    });
    return { ok: true, physical_status: opts.physicalStatus, reservation_status: opts.reservationStatus };
}

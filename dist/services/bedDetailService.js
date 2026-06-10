import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
const BED_NAME_RE = /^[A-Za-z0-9 \-]+$/;
function validateBedName(name) {
    if (!name.trim())
        throw new HttpError(400, "Bed name required");
    if (!BED_NAME_RE.test(name.trim()))
        throw new HttpError(400, `Bed name "${name}" contains invalid characters. Only letters, numbers, spaces, and hyphens are allowed.`);
}
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
/** Generate beds from an explicit list of names (frontend expands patterns). */
export async function generateBeds(opts) {
    if (!await db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
        throw new HttpError(404, "Ward not found");
    if (opts.bedNames.length === 0)
        throw new HttpError(400, "At least one bed name required");
    if (opts.bedNames.length > 500)
        throw new HttpError(400, "Cannot generate more than 500 beds at once");
    for (const n of opts.bedNames)
        validateBedName(n);
    const now = Date.now();
    let inserted = 0;
    await db.transaction(async () => {
        for (const rawName of opts.bedNames) {
            const name = rawName.trim();
            const r = await db.prepare("INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?) ON CONFLICT (ward_id, bed_name) DO NOTHING").run(opts.wardId, name, now, opts.userId);
            inserted += r.changes;
        }
        await _recalcWardTotals(opts.wardId);
    });
    await audit(opts.userId, "beds_generate", String(opts.wardId), { count: opts.bedNames.length, inserted });
    return { ok: true, generated: inserted };
}
export async function addSingleBed(opts) {
    if (!await db.prepare("SELECT id FROM wards WHERE id=?").get(opts.wardId))
        throw new HttpError(404, "Ward not found");
    const trimmed = opts.bedName.trim();
    validateBedName(trimmed);
    const now = Date.now();
    let newId = 0;
    await db.transaction(async () => {
        const existing = await db.prepare("SELECT id FROM bed_details WHERE ward_id=? AND bed_name=?").get(opts.wardId, trimmed);
        if (existing)
            throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);
        const r = await db.prepare("INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?) RETURNING id").run(opts.wardId, trimmed, now, opts.userId);
        newId = Number(r.lastInsertRowid);
        await _recalcWardTotals(opts.wardId);
    });
    await audit(opts.userId, "bed_add", String(opts.wardId), { bedName: trimmed });
    return { ok: true, id: newId };
}
export async function listBeds(wardId, physicalStatus, reservationStatus) {
    let sql = `SELECT id, ward_id, bed_name, physical_status, reservation_status,
                    bed_type, operational_status, updated_at, updated_by
             FROM bed_details WHERE ward_id=?`;
    const params = [wardId];
    if (physicalStatus) {
        if (!["VACANT", "OCCUPIED"].includes(physicalStatus.toUpperCase()))
            throw new HttpError(400, "Invalid physical_status filter");
        sql += " AND physical_status=?";
        params.push(physicalStatus.toUpperCase());
    }
    if (reservationStatus) {
        if (!["NONE", "RESERVED"].includes(reservationStatus.toUpperCase()))
            throw new HttpError(400, "Invalid reservation_status filter");
        sql += " AND reservation_status=?";
        params.push(reservationStatus.toUpperCase());
    }
    // Natural sort: prefix alphabetically, then numeric portion numerically, then full name
    sql += ` ORDER BY
    substring(bed_name from '^[^0-9]*') ASC,
    NULLIF(substring(bed_name from '[0-9]+'), '')::bigint NULLS LAST,
    bed_name ASC`;
    return db.prepare(sql).all(...params);
}
export async function renameBed(opts) {
    const bed = await db.prepare("SELECT id, ward_id, bed_name FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    const trimmed = opts.newBedName.trim();
    validateBedName(trimmed);
    if (trimmed === bed.bed_name)
        return { ok: true };
    const clash = await db.prepare("SELECT 1 FROM bed_details WHERE ward_id=? AND bed_name=? AND id!=?").get(bed.ward_id, trimmed, opts.bedId);
    if (clash)
        throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);
    await db.prepare("UPDATE bed_details SET bed_name=?, updated_at=? WHERE id=?")
        .run(trimmed, Date.now(), opts.bedId);
    await audit(opts.userId, "bed_rename", String(opts.bedId), { from: bed.bed_name, to: trimmed });
    return { ok: true };
}
export async function updateBedMaster(opts) {
    const bed = await db.prepare("SELECT id, ward_id FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    const now = Date.now();
    if (opts.bedType !== undefined) {
        const valid = ["Census", "Non-Census"];
        if (!valid.includes(opts.bedType))
            throw new HttpError(400, `Invalid bed_type. Must be one of: ${valid.join(", ")}`);
        await db.prepare("UPDATE bed_details SET bed_type=?, updated_at=? WHERE id=?")
            .run(opts.bedType, now, opts.bedId);
    }
    if (opts.operationalStatus !== undefined) {
        await db.prepare("UPDATE bed_details SET operational_status=?, updated_at=? WHERE id=?")
            .run(opts.operationalStatus, now, opts.bedId);
    }
    await audit(opts.userId, "bed_master_edit", String(opts.bedId), { bedType: opts.bedType, operationalStatus: opts.operationalStatus });
    return { ok: true };
}
export async function deleteBed(opts) {
    const bed = await db.prepare("SELECT id, ward_id, bed_name FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    await db.transaction(async () => {
        await db.prepare("DELETE FROM bed_details WHERE id=?").run(opts.bedId);
        await _recalcWardTotals(bed.ward_id);
    });
    await audit(opts.userId, "bed_delete", String(opts.bedId), { bedName: bed.bed_name, wardId: bed.ward_id });
    return { ok: true };
}
export async function updateBedStatus(opts) {
    const bed = await db.prepare("SELECT id, ward_id, physical_status, reservation_status FROM bed_details WHERE id=?").get(opts.bedId);
    if (!bed)
        throw new HttpError(404, "Bed not found");
    if (!["VACANT", "OCCUPIED"].includes(opts.physicalStatus))
        throw new HttpError(400, "Invalid physical_status");
    if (!["NONE", "RESERVED"].includes(opts.reservationStatus))
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

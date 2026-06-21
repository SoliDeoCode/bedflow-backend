import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

const BED_NAME_RE = /^[A-Za-z0-9 \-]+$/;

function validateBedName(name: string) {
  if (!name.trim()) throw new HttpError(400, "Bed name required");
  if (!BED_NAME_RE.test(name.trim()))
    throw new HttpError(400, `Bed name "${name}" contains invalid characters. Only letters, numbers, spaces, and hyphens are allowed.`);
}

export async function _recalcWardTotals(wardId: number, actorId: number) {
  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN physical_status='VACANT'   AND reservation_status='NONE'     THEN 1 ELSE 0 END) AS vacant,
      SUM(CASE WHEN physical_status='VACANT'   AND reservation_status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN physical_status='OCCUPIED' AND reservation_status='NONE'     THEN 1 ELSE 0 END) AS occupied,
      SUM(CASE WHEN physical_status='OCCUPIED' AND reservation_status='RESERVED' THEN 1 ELSE 0 END) AS occupied_reserved
    FROM bed_details WHERE ward_id = ?
  `).get<{ total: number; vacant: number; reserved: number; occupied: number; occupied_reserved: number }>(wardId);
  if (!counts) return;
  const total  = Math.max(0, counts.total || 0);
  const vacant = counts.vacant || 0;
  const reserved = counts.reserved || 0;
  const occupied = counts.occupied || 0;
  const occupiedReserved = counts.occupied_reserved || 0;
  const now = Date.now();
  // UPSERT: creates the beds row if it was never inserted (e.g. ward added via
  // migration or direct SQL), preventing the silent no-op of a plain UPDATE.
  // updated_by must be stamped here too — otherwise a nurse's bed-level edit
  // (which lands here) leaves the ward's attribution pointing at whoever last
  // ran a PRE round, even though updated_at correctly moved.
  await db.prepare(`
    INSERT INTO beds (ward_id, total, vacant, reserved, occupied, occupied_reserved, updated_at, updated_by)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (ward_id) DO UPDATE SET
      total             = EXCLUDED.total,
      vacant            = EXCLUDED.vacant,
      reserved          = EXCLUDED.reserved,
      occupied          = EXCLUDED.occupied,
      occupied_reserved = EXCLUDED.occupied_reserved,
      updated_at        = EXCLUDED.updated_at,
      updated_by        = EXCLUDED.updated_by
  `).run(wardId, total, vacant, reserved, occupied, occupiedReserved, now, actorId);

  // wards.total_beds is a denormalized copy read by every dashboard/round/census
  // query — keep it locked to the real bed_details count so it can't drift
  // whenever an individual bed is added or deleted.
  await db.prepare("UPDATE wards SET total_beds=? WHERE id=?").run(total, wardId);
}

/** Generate beds from an explicit list of names (frontend expands patterns). */
export async function generateBeds(opts: {
  wardId: number; bedNames: string[]; userId: number; operationalStatus?: boolean; bedType?: string; acStatus?: boolean;
}) {
  const ward = await db.prepare("SELECT id, bed_type, operational, ac FROM wards WHERE id=?")
    .get<{ id: number; bed_type: string; operational: boolean; ac: boolean }>(opts.wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  if (opts.bedNames.length === 0)
    throw new HttpError(400, "At least one bed name required");
  if (opts.bedNames.length > 500)
    throw new HttpError(400, "Cannot generate more than 500 beds at once");

  for (const n of opts.bedNames) validateBedName(n);

  const bedType     = opts.bedType ?? ward.bed_type ?? "Census";
  const operational = opts.operationalStatus ?? ward.operational ?? true;
  const acStatus    = opts.acStatus ?? ward.ac ?? true;
  const now = Date.now();
  let inserted = 0;
  await db.transaction(async () => {
    for (const rawName of opts.bedNames) {
      const name = rawName.trim();
      const r = await db.prepare(
        "INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, ac_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?,?,?,?) ON CONFLICT (ward_id, bed_name) DO NOTHING"
      ).run(opts.wardId, name, bedType, operational, acStatus, now, opts.userId);
      inserted += r.changes;
    }
    await _recalcWardTotals(opts.wardId, opts.userId);
  });

  await audit(opts.userId, "beds_generate", String(opts.wardId),
    { count: opts.bedNames.length, inserted });
  return { ok: true, generated: inserted };
}

export async function addSingleBed(opts: {
  wardId: number; bedName: string; userId: number; operationalStatus?: boolean; bedType?: string; acStatus?: boolean;
}) {
  const ward = await db.prepare("SELECT id, bed_type, operational, ac FROM wards WHERE id=?")
    .get<{ id: number; bed_type: string; operational: boolean; ac: boolean }>(opts.wardId);
  if (!ward) throw new HttpError(404, "Ward not found");

  const trimmed     = opts.bedName.trim();
  const bedType     = opts.bedType ?? ward.bed_type ?? "Census";
  const operational = opts.operationalStatus ?? ward.operational ?? true;
  const acStatus    = opts.acStatus ?? ward.ac ?? true;
  validateBedName(trimmed);

  const now = Date.now();
  let newId = 0;
  await db.transaction(async () => {
    const r = await db.prepare(
      "INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, ac_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?,?,?,?) ON CONFLICT (ward_id, bed_name) DO NOTHING RETURNING id"
    ).run(opts.wardId, trimmed, bedType, operational, acStatus, now, opts.userId);
    if (r.changes === 0) throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);
    newId = Number(r.lastInsertRowid);
    await _recalcWardTotals(opts.wardId, opts.userId);
  });

  await audit(opts.userId, "bed_add", String(opts.wardId), { bedName: trimmed });
  return { ok: true, id: newId };
}

export interface BedDetail {
  id: number; ward_id: number; bed_name: string;
  physical_status: string; reservation_status: string;
  bed_type: string; operational_status: boolean; ac_status: boolean;
  payer_type: string | null; destination: string | null; reservation_note: string | null;
  updated_at: number; updated_by: number | null;
}

export async function listBeds(
  wardId: number,
  physicalStatus?: string,
  reservationStatus?: string,
  operationalOnly = false,
): Promise<BedDetail[]> {
  let sql = `SELECT id, ward_id, bed_name, physical_status, reservation_status,
                    bed_type, operational_status, ac_status, payer_type, destination, reservation_note, updated_at, updated_by
             FROM bed_details WHERE ward_id=?`;
  const params: unknown[] = [wardId];
  if (operationalOnly) sql += " AND operational_status = true";
  if (physicalStatus) {
    if (!["VACANT", "OCCUPIED"].includes(physicalStatus.toUpperCase()))
      throw new HttpError(400, "Invalid physical_status filter");
    sql += " AND physical_status=?"; params.push(physicalStatus.toUpperCase());
  }
  if (reservationStatus) {
    if (!["NONE", "RESERVED"].includes(reservationStatus.toUpperCase()))
      throw new HttpError(400, "Invalid reservation_status filter");
    sql += " AND reservation_status=?"; params.push(reservationStatus.toUpperCase());
  }
  // Natural sort: prefix alphabetically, then numeric portion numerically, then full name
  sql += ` ORDER BY
    substring(bed_name from '^[^0-9]*') ASC,
    NULLIF(substring(bed_name from '[0-9]+'), '')::bigint NULLS LAST,
    bed_name ASC`;

  return db.prepare(sql).all<BedDetail>(...params);
}

// nurse_access_assignments.bed_names stores bed NAMES (JSON array), not ids —
// a rename would otherwise silently revoke that nurse's access to the bed.
async function renameBedInNurseAccess(wardId: number, oldName: string, newName: string) {
  const rows = await db.prepare(
    "SELECT id, bed_names FROM nurse_access_assignments WHERE ward_id=? AND access_type='BEDS' AND bed_names LIKE ?"
  ).all<{ id: number; bed_names: string }>(wardId, `%${oldName}%`);
  for (const row of rows) {
    let beds: unknown;
    try { beds = JSON.parse(row.bed_names || "[]"); } catch { continue; }
    if (!Array.isArray(beds) || !beds.includes(oldName)) continue;
    const updated = beds.map((b) => (b === oldName ? newName : b));
    await db.prepare("UPDATE nurse_access_assignments SET bed_names=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(updated), Date.now(), row.id);
  }
}

export async function renameBed(opts: {
  bedId: number; newBedName: string; userId: number;
}) {
  const bed = await db.prepare(
    "SELECT id, ward_id, bed_name FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_name: string }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  const trimmed = opts.newBedName.trim();
  validateBedName(trimmed);
  if (trimmed === bed.bed_name) return { ok: true };

  const clash = await db.prepare(
    "SELECT 1 FROM bed_details WHERE ward_id=? AND bed_name=? AND id!=?"
  ).get(bed.ward_id, trimmed, opts.bedId);
  if (clash) throw new HttpError(409, `Bed "${trimmed}" already exists in this ward`);

  await db.prepare("UPDATE bed_details SET bed_name=?, updated_at=? WHERE id=?")
    .run(trimmed, Date.now(), opts.bedId);
  await renameBedInNurseAccess(bed.ward_id, bed.bed_name, trimmed);

  await audit(opts.userId, "bed_rename", String(opts.bedId),
    { from: bed.bed_name, to: trimmed });
  return { ok: true };
}

export async function updateBedMaster(opts: {
  bedId: number; bedType?: string; operationalStatus?: boolean; acStatus?: boolean; userId: number;
}) {
  const bed = await db.prepare(
    "SELECT id, ward_id, operational_status FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; operational_status: boolean }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

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
    await db.prepare(
      `INSERT INTO bed_operational_log (bed_id, ward_id, changed_by, changed_at, old_value, new_value, forced_vacant)
       VALUES (?,?,?,?,?,?,?)`
    ).run(opts.bedId, bed.ward_id, opts.userId, now, bed.operational_status, opts.operationalStatus, false);
  }
  if (opts.acStatus !== undefined) {
    await db.prepare("UPDATE bed_details SET ac_status=?, updated_at=? WHERE id=?")
      .run(opts.acStatus, now, opts.bedId);
  }

  await audit(opts.userId, "bed_master_edit", String(opts.bedId),
    { bedType: opts.bedType, operationalStatus: opts.operationalStatus, acStatus: opts.acStatus });
  return { ok: true };
}

export async function deleteBed(opts: { bedId: number; userId: number }) {
  const bed = await db.prepare(
    "SELECT id, ward_id, bed_name, physical_status, reservation_status, payer_type, destination, reservation_note FROM bed_details WHERE id=?"
  ).get<{ id: number; ward_id: number; bed_name: string; physical_status: string; reservation_status: string; payer_type: string | null; destination: string | null; reservation_note: string | null }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  await db.transaction(async () => {
    // Tombstone before DELETE — bed_id becomes NULL via SET NULL FK after row is gone,
    // but bed_name/ward_id remain so history stays queryable. Deleting a bed never
    // deletes its bed_movements rows or audit_logs entries — only this row.
    await db.prepare(
      `INSERT INTO bed_movements
         (bed_id, bed_name, ward_id, old_physical, new_physical, old_reservation, new_reservation, payer_type, destination, reservation_note, changed_by, changed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(opts.bedId, bed.bed_name, bed.ward_id,
          bed.physical_status, "DELETED",
          bed.reservation_status, "DELETED",
          bed.payer_type, bed.destination, bed.reservation_note, opts.userId, Date.now());
    await db.prepare("DELETE FROM bed_details WHERE id=?").run(opts.bedId);
    await _recalcWardTotals(bed.ward_id, opts.userId);
  });

  await audit(opts.userId, "bed_delete", String(opts.bedId), {
    bedName: bed.bed_name,
    wardId: bed.ward_id,
    lastStatus: {
      physical: bed.physical_status,
      reservation: bed.reservation_status,
      payer: bed.payer_type,
      destination: bed.destination,
      reservationNote: bed.reservation_note,
    },
  });
  return { ok: true };
}

export async function updateBedStatus(opts: {
  bedId: number; physicalStatus: string; reservationStatus: string;
  payerType?: string | null; destination?: string | null; reservationNote?: string | null; userId: number;
}) {
  const bed = await db.prepare(
    `SELECT bd.id, bd.ward_id, bd.bed_name, bd.physical_status, bd.reservation_status,
            bd.payer_type, bd.destination, bd.reservation_note, bd.updated_at, bd.operational_status,
            w.operational AS ward_operational
     FROM bed_details bd
     JOIN wards w ON w.id = bd.ward_id
     WHERE bd.id = ?`
  ).get<{
    id: number; ward_id: number; bed_name: string; physical_status: string; reservation_status: string;
    payer_type: string | null; destination: string | null; reservation_note: string | null; updated_at: number;
    operational_status: boolean; ward_operational: boolean;
  }>(opts.bedId);
  if (!bed) throw new HttpError(404, "Bed not found");

  if (!bed.ward_operational)
    throw new HttpError(409, "This ward is currently non-operational. Contact your manager.");
  if (!bed.operational_status)
    throw new HttpError(409, "This bed is non-operational. Contact your manager.");

  if (!["VACANT", "OCCUPIED"].includes(opts.physicalStatus))
    throw new HttpError(400, "Invalid physical_status");
  if (!["NONE", "RESERVED"].includes(opts.reservationStatus))
    throw new HttpError(400, "Invalid reservation_status");

  // Determine new payer_type:
  // - Going VACANT (any reservation): always clear to NULL
  // - Going OCCUPIED: use provided payerType, fall back to existing if not provided
  // - Going OCCUPIED+RESERVED (same patient to OT): keep existing unless explicitly changed
  let newPayerType: string | null;
  if (opts.physicalStatus === "VACANT") {
    newPayerType = null;
  } else {
    // OCCUPIED or OCCUPIED+RESERVED
    newPayerType = opts.payerType !== undefined ? (opts.payerType ?? null) : bed.payer_type;
  }

  // OCCUPIED+RESERVED means "patient is temporarily away at a destination
  // (e.g. OT, Scanning) but the bed is held for them". Destination is required
  // whenever the bed is entering or staying in that state, and is dropped
  // automatically the moment it leaves (returns to plain OCCUPIED = patient
  // came back; goes VACANT = patient did not come back). The bed_movements
  // row for that leaving transition still carries the destination the patient
  // had been sent to, so history reads as a complete story even though
  // bed_details.destination itself is cleared.
  const enteringOrStayingOccRes = opts.physicalStatus === "OCCUPIED" && opts.reservationStatus === "RESERVED";
  const wasOccRes = bed.physical_status === "OCCUPIED" && bed.reservation_status === "RESERVED";

  let newDestination: string | null;
  if (enteringOrStayingOccRes) {
    const dest = (opts.destination ?? "").toString().trim();
    if (!dest) throw new HttpError(400, "Destination is required when a bed is Occupied + Reserved (e.g. OT, Scanning)");
    newDestination = dest;
  } else {
    newDestination = null;
  }
  // What to record on the bed_movements row itself: the destination being set
  // (entering/staying OCC+RES) or, when leaving OCC+RES, the destination the
  // patient had been sent to — never silently dropped from history.
  const movementDestination = enteringOrStayingOccRes ? newDestination : (wasOccRes ? bed.destination : null);

  // VACANT+RESERVED means "bed held for an incoming patient" (e.g. transfer,
  // scheduled admission). A note describing why is required, same as
  // destination is required for OCC+RES.
  const enteringOrStayingVacRes = opts.physicalStatus === "VACANT" && opts.reservationStatus === "RESERVED";
  const wasVacRes = bed.physical_status === "VACANT" && bed.reservation_status === "RESERVED";

  let newReservationNote: string | null;
  if (enteringOrStayingVacRes) {
    const note = opts.reservationNote !== undefined
      ? (opts.reservationNote ?? "").toString().trim()
      : (bed.reservation_note ?? "").trim();
    if (!note) throw new HttpError(400, "A note is required when a bed is Vacant + Reserved (why is it being held?)");
    newReservationNote = note;
  } else {
    newReservationNote = null;
  }
  const movementReservationNote = enteringOrStayingVacRes ? newReservationNote : (wasVacRes ? bed.reservation_note : null);

  const noStatusChange      = bed.physical_status === opts.physicalStatus && bed.reservation_status === opts.reservationStatus;
  const noPayerChange       = (newPayerType ?? null) === (bed.payer_type ?? null);
  const noDestinationChange = (newDestination ?? null) === (bed.destination ?? null);
  const noNoteChange        = (newReservationNote ?? null) === (bed.reservation_note ?? null);
  if (noStatusChange && noPayerChange && noDestinationChange && noNoteChange)
    return { ok: true, ward_id: bed.ward_id, physical_status: opts.physicalStatus, reservation_status: opts.reservationStatus, payer_type: newPayerType, destination: newDestination, reservation_note: newReservationNote };

  const now = Date.now();
  await db.transaction(async () => {
    // Optimistic lock: only update if nobody changed the row since we read it.
    const r = await db.prepare(
      "UPDATE bed_details SET physical_status=?, reservation_status=?, payer_type=?, destination=?, reservation_note=?, updated_at=?, updated_by=? WHERE id=? AND updated_at=?"
    ).run(opts.physicalStatus, opts.reservationStatus, newPayerType, newDestination, newReservationNote, now, opts.userId, opts.bedId, bed.updated_at);
    if (r.changes === 0)
      throw new HttpError(409, "This bed was just updated by someone else. Refresh to see the latest status.");
    // bed_movements is an append-only audit trail — rows here are never
    // updated or deleted, only ever inserted.
    await db.prepare(
      `INSERT INTO bed_movements
         (bed_id, bed_name, ward_id, old_physical, new_physical, old_reservation, new_reservation, payer_type, destination, reservation_note, changed_by, changed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(opts.bedId, bed.bed_name, bed.ward_id,
          bed.physical_status, opts.physicalStatus,
          bed.reservation_status, opts.reservationStatus,
          newPayerType, movementDestination, movementReservationNote, opts.userId, now);
    await _recalcWardTotals(bed.ward_id, opts.userId);
  });

  await audit(opts.userId, "bed_status_update", String(opts.bedId), {
    old: { physical: bed.physical_status, reservation: bed.reservation_status, payer: bed.payer_type, destination: bed.destination, note: bed.reservation_note },
    new: { physical: opts.physicalStatus,  reservation: opts.reservationStatus,  payer: newPayerType,  destination: movementDestination, note: movementReservationNote },
    wardId: bed.ward_id,
  });
  return { ok: true, ward_id: bed.ward_id, physical_status: opts.physicalStatus, reservation_status: opts.reservationStatus, payer_type: newPayerType, destination: newDestination, reservation_note: newReservationNote };
}

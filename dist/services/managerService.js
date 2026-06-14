import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
const now = () => Date.now();
function isUniqueViolation(err) {
    return /unique/i.test(String(err?.message ?? ""));
}
// ── BUILDING BLOCKS (Block A / Block B …) ────────────────────────────────────
export async function listBuildingBlocks() {
    return db.prepare(`SELECT bb.id, bb.name, bb.label, bb.sort_order,
            COUNT(f.id)::int AS floor_count
     FROM building_blocks bb
     LEFT JOIN floors f ON f.building_block_id = bb.id
     GROUP BY bb.id, bb.name, bb.label, bb.sort_order
     ORDER BY bb.sort_order, bb.name`).all();
}
export async function createBuildingBlock(opts) {
    const name = opts.name.trim().toUpperCase();
    if (!name)
        throw new HttpError(400, "Block name required");
    const t = now();
    let r;
    try {
        r = await db.transaction(async () => {
            const next = (await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM building_blocks").get()).n;
            return db.prepare("INSERT INTO building_blocks (name, label, sort_order, created_at, updated_at) VALUES (?,?,?,?,?) RETURNING id").run(name, opts.label?.trim() || `Block ${name}`, next, t, t);
        });
    }
    catch (err) {
        if (isUniqueViolation(err))
            throw new HttpError(409, `Block "${name}" already exists`);
        throw err;
    }
    await audit(opts.managerId, "building_block_create", name, {});
    return { ok: true, id: Number(r.lastInsertRowid), name };
}
export async function editBuildingBlock(opts) {
    const existing = await db.prepare("SELECT id, name FROM building_blocks WHERE id=?")
        .get(opts.blockId);
    if (!existing)
        throw new HttpError(404, "Building block not found");
    const t = now();
    if (opts.name !== undefined) {
        const n = opts.name.trim().toUpperCase();
        try {
            await db.prepare("UPDATE building_blocks SET name=?, updated_at=? WHERE id=?").run(n, t, opts.blockId);
        }
        catch (err) {
            if (isUniqueViolation(err))
                throw new HttpError(409, `Block "${n}" already exists`);
            throw err;
        }
        await db.prepare("UPDATE floors SET block_label=?, updated_at=? WHERE building_block_id=?").run(n, t, opts.blockId);
    }
    if (opts.label !== undefined)
        await db.prepare("UPDATE building_blocks SET label=?, updated_at=? WHERE id=?")
            .run(opts.label.trim() || null, t, opts.blockId);
    if (opts.sortOrder !== undefined)
        await db.prepare("UPDATE building_blocks SET sort_order=?, updated_at=? WHERE id=?")
            .run(opts.sortOrder, t, opts.blockId);
    await audit(opts.managerId, "building_block_edit", existing.name, opts);
    return { ok: true };
}
export async function deleteBuildingBlock(blockId, managerId) {
    const b = await db.prepare("SELECT id, name FROM building_blocks WHERE id=?")
        .get(blockId);
    if (!b)
        throw new HttpError(404, "Building block not found");
    const fc = (await db.prepare("SELECT COUNT(*) AS n FROM floors WHERE building_block_id=?")
        .get(blockId)).n;
    if (fc > 0)
        throw new HttpError(409, `Block "${b.name}" has ${fc} floor(s). Remove them first.`);
    await db.prepare("DELETE FROM building_blocks WHERE id=?").run(blockId);
    await audit(managerId, "building_block_delete", b.name, { blockId });
    return { ok: true };
}
// ── FLOORS ────────────────────────────────────────────────────────────────────
export async function listFloors() {
    return db.prepare(`SELECT f.id, f.name, f.building_block_id, f.sort_order,
            bb.name AS block_name, bb.label AS block_label,
            (SELECT COUNT(*)::int FROM wards w WHERE w.floor_id = f.id) AS ward_count,
            (SELECT id   FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_id,
            (SELECT name FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_name,
            (SELECT shift FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_shift
     FROM floors f
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     ORDER BY bb.sort_order, bb.name, f.sort_order, f.name`).all();
}
export async function createFloor(opts) {
    const name = opts.name.trim();
    if (!name)
        throw new HttpError(400, "Floor name required");
    const bb = await db.prepare("SELECT id, name FROM building_blocks WHERE id=?")
        .get(opts.buildingBlockId);
    if (!bb)
        throw new HttpError(404, "Building block not found");
    const t = now();
    let r;
    try {
        r = await db.transaction(async () => {
            const next = (await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM floors WHERE building_block_id=?").get(opts.buildingBlockId)).n;
            return db.prepare("INSERT INTO floors (name, code, block_label, building_block_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id").run(name, name.replace(/\s+/g, "").substring(0, 20).toUpperCase(), bb.name, opts.buildingBlockId, next, t, t);
        });
    }
    catch (err) {
        if (isUniqueViolation(err))
            throw new HttpError(409, `A floor named "${name}" already exists in Block ${bb.name}`);
        throw err;
    }
    await audit(opts.managerId, "floor_create", `${bb.name}-${name}`, {});
    return { ok: true, id: Number(r.lastInsertRowid), name };
}
export async function editFloor(opts) {
    const floor = await db.prepare("SELECT id, name FROM floors WHERE id=?")
        .get(opts.floorId);
    if (!floor)
        throw new HttpError(404, "Floor not found");
    const name = opts.name.trim();
    if (!name)
        throw new HttpError(400, "Floor name required");
    const t = now();
    try {
        await db.prepare("UPDATE floors SET name=?, code=?, updated_at=? WHERE id=?")
            .run(name, name.replace(/\s+/g, "").substring(0, 20).toUpperCase(), t, opts.floorId);
    }
    catch (err) {
        if (isUniqueViolation(err))
            throw new HttpError(409, "A floor with a similar name already exists in this block");
        throw err;
    }
    await audit(opts.managerId, "floor_edit", name, { floorId: opts.floorId });
    return { ok: true };
}
export async function deleteFloor(floorId, managerId) {
    const floor = await db.prepare("SELECT id, name FROM floors WHERE id=?")
        .get(floorId);
    if (!floor)
        throw new HttpError(404, "Floor not found");
    const wc = (await db.prepare("SELECT COUNT(*) AS n FROM wards WHERE floor_id=?")
        .get(floorId)).n;
    if (wc > 0)
        throw new HttpError(409, `"${floor.name}" still has ${wc} ward(s). Remove them first.`);
    await db.prepare("UPDATE users SET floor_id=NULL WHERE floor_id=?").run(floorId);
    await db.prepare("DELETE FROM floors WHERE id=?").run(floorId);
    await audit(managerId, "floor_delete", floor.name, { floorId });
    return { ok: true };
}
// ── WARD lifecycle ────────────────────────────────────────────────────────────
export async function createWard(opts) {
    const floor = await db.prepare("SELECT id, name FROM floors WHERE id=?")
        .get(opts.floorId);
    if (!floor)
        throw new HttpError(404, "Floor not found");
    let stationName = null;
    if (opts.stationId) {
        const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
            .get(opts.stationId);
        if (!ns)
            throw new HttpError(404, "Nursing station not found");
        stationName = ns.name;
    }
    const total = Math.max(0, Math.floor(opts.totalBeds));
    const bedType = opts.bedType ?? "Census";
    const operational = opts.operational ?? true;
    const t = now();
    try {
        let wardId = 0;
        await db.transaction(async () => {
            const r = await db.prepare(`INSERT INTO wards (name, floor_id, total_beds, nursing_station, station_id, unit_type, room_type, bed_type, operational, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(opts.name.trim(), opts.floorId, total, stationName, opts.stationId ?? null, opts.unitType?.trim() || null, opts.roomType?.trim() || null, bedType, operational, t, t);
            wardId = Number(r.lastInsertRowid);
            await db.prepare("INSERT INTO beds (ward_id, total) VALUES (?,?)").run(wardId, total);
            if (total > 0) {
                const placeholders = Array.from({ length: total }, () => "(?,?,'VACANT','NONE',?,?,?,?)").join(",");
                const values = [];
                for (let i = 1; i <= total; i++)
                    values.push(wardId, String(i), bedType, operational, t, opts.managerId);
                await db.prepare(`INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, updated_at, updated_by) VALUES ${placeholders}`).run(...values);
            }
        });
        await audit(opts.managerId, "ward_create", floor.name, { name: opts.name, totalBeds: total, bedType, operational });
        return { ok: true, id: wardId };
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(409, `Ward "${opts.name}" already exists on this floor`);
    }
}
export async function editWard(opts) {
    const ward = await db.prepare("SELECT id, floor_id FROM wards WHERE id=?")
        .get(opts.wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    const t = now();
    // Validate totalBeds before entering the transaction so other fields aren't silently skipped
    if (opts.totalBeds !== undefined) {
        const actual = (await db.prepare("SELECT COUNT(*) AS c FROM bed_details WHERE ward_id=?")
            .get(opts.wardId))?.c ?? 0;
        if (opts.totalBeds !== actual)
            throw new HttpError(409, `Capacity is derived from beds (currently ${actual}). Add or delete beds to change it.`);
    }
    await db.transaction(async () => {
        if (opts.name !== undefined)
            await db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?")
                .run(opts.name.trim(), t, opts.wardId);
        if (opts.totalBeds !== undefined) {
            await db.prepare("UPDATE wards SET updated_at=? WHERE id=?").run(t, opts.wardId);
        }
        if (opts.floorId !== undefined) {
            const f = await db.prepare("SELECT id FROM floors WHERE id=?").get(opts.floorId);
            if (!f)
                throw new HttpError(404, "Floor not found");
            await db.prepare("UPDATE wards SET floor_id=?, updated_at=? WHERE id=?").run(opts.floorId, t, opts.wardId);
        }
        if (opts.stationId !== undefined) {
            let sName = null;
            if (opts.stationId) {
                const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
                    .get(opts.stationId);
                if (!ns)
                    throw new HttpError(404, "Nursing station not found");
                sName = ns.name;
            }
            await db.prepare("UPDATE wards SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
                .run(opts.stationId, sName, t, opts.wardId);
        }
        if (opts.unitType !== undefined)
            await db.prepare("UPDATE wards SET unit_type=?, updated_at=? WHERE id=?")
                .run(opts.unitType?.trim() || null, t, opts.wardId);
        if (opts.roomType !== undefined)
            await db.prepare("UPDATE wards SET room_type=?, updated_at=? WHERE id=?")
                .run(opts.roomType?.trim() || null, t, opts.wardId);
        if (opts.bedType != null)
            await db.prepare("UPDATE wards SET bed_type=?, updated_at=? WHERE id=?")
                .run(opts.bedType, t, opts.wardId);
        if (opts.operational != null)
            await db.prepare("UPDATE wards SET operational=?, updated_at=? WHERE id=?")
                .run(opts.operational, t, opts.wardId);
    });
    const floorName = ward.floor_id
        ? (await db.prepare("SELECT name FROM floors WHERE id=?").get(ward.floor_id))?.name
        : "unknown";
    await audit(opts.managerId, "ward_edit", floorName ?? "unknown", { wardId: opts.wardId });
    return { ok: true };
}
export async function deleteWard(wardId, managerId) {
    const ward = await db.prepare("SELECT floor_id FROM wards WHERE id=?")
        .get(wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    await db.prepare("DELETE FROM wards WHERE id=?").run(wardId);
    await audit(managerId, "ward_delete", "floor", { wardId });
    return { ok: true };
}
// ── PRE user lifecycle ────────────────────────────────────────────────────────
export async function createPre(opts) {
    const username = opts.username.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username))
        throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
    if (await db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
        throw new HttpError(409, "Username already taken");
    if (opts.preBlockId != null) {
        const pb = await db.prepare("SELECT name FROM pre_blocks WHERE id=?")
            .get(opts.preBlockId);
        if (!pb)
            throw new HttpError(404, "PRE Block not found");
    }
    const t = now();
    const shift = opts.shift || "morning";
    const r = await db.prepare("INSERT INTO users (username,password_hash,role,name,shift,pre_block_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id").run(username, bcrypt.hashSync(opts.password, 10), "PRE", opts.name, shift, opts.preBlockId ?? null, t, t);
    const blockName = opts.preBlockId
        ? (await db.prepare("SELECT name FROM pre_blocks WHERE id=?").get(opts.preBlockId))?.name
        : null;
    await audit(opts.managerId, "pre_create", blockName ?? "unassigned", { username, name: opts.name, shift });
    return { ok: true, id: Number(r.lastInsertRowid), username };
}
export async function editPre(opts) {
    const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
        .get(opts.userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    if (opts.preBlockId != null) {
        const pb = await db.prepare("SELECT id FROM pre_blocks WHERE id=?").get(opts.preBlockId);
        if (!pb)
            throw new HttpError(404, "PRE Block not found");
    }
    const t = now();
    await db.transaction(async () => {
        if (opts.name !== undefined)
            await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, t, opts.userId);
        if (opts.password)
            await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
                .run(bcrypt.hashSync(opts.password, 10), t, opts.userId);
        if (opts.shift)
            await db.prepare("UPDATE users SET shift=?, updated_at=? WHERE id=?").run(opts.shift, t, opts.userId);
        if (opts.preBlockId !== undefined)
            await db.prepare("UPDATE users SET pre_block_id=?, updated_at=? WHERE id=?")
                .run(opts.preBlockId, t, opts.userId);
    });
    await audit(opts.managerId, "pre_edit", null, { userId: opts.userId });
    return { ok: true };
}
export async function setPreShift(userId, shift, managerId) {
    const user = await db.prepare("SELECT id,role FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    await db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, now(), userId);
    await audit(managerId, "pre_shift", null, { userId, shift });
    return { ok: true, shift };
}
export async function deletePre(userId, managerId) {
    const user = await db.prepare("SELECT id,role,name,floor_id FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    await db.prepare("DELETE FROM users WHERE id=?").run(userId);
    await audit(managerId, "pre_delete", null, { userId, name: user.name });
    return { ok: true };
}
// ── Nurse In-Charge lifecycle ─────────────────────────────────────────────────
export async function createNurse(opts) {
    const username = opts.username.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username))
        throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
    if (await db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
        throw new HttpError(409, "Username already taken");
    let stationName = null;
    if (opts.stationId) {
        const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
            .get(opts.stationId);
        if (!ns)
            throw new HttpError(404, "Nursing station not found");
        stationName = ns.name;
    }
    const t = now();
    const r = await db.prepare(`INSERT INTO users
       (username,password_hash,role,name,shift,nursing_station,station_id,
        employee_id,phone,email,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(username, bcrypt.hashSync(opts.password, 10), "NURSE", opts.name.trim(), "morning", stationName, opts.stationId ?? null, opts.employeeId?.trim() || null, opts.phone?.trim() || null, opts.email?.trim() || null, t, t);
    await audit(opts.managerId, "nurse_create", stationName ?? "unassigned", { username, name: opts.name });
    return { ok: true, id: Number(r.lastInsertRowid), username };
}
export async function editNurse(opts) {
    const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
        .get(opts.userId);
    if (!user || user.role !== "NURSE")
        throw new HttpError(404, "Nurse not found");
    const t = now();
    await db.transaction(async () => {
        if (opts.name !== undefined)
            await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, t, opts.userId);
        if (opts.password)
            await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
                .run(bcrypt.hashSync(opts.password, 10), t, opts.userId);
        if (opts.stationId !== undefined) {
            if (opts.stationId === null) {
                await db.prepare("UPDATE users SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE id=?")
                    .run(t, opts.userId);
            }
            else {
                const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
                    .get(opts.stationId);
                if (!ns)
                    throw new HttpError(404, "Nursing station not found");
                await db.prepare("UPDATE users SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
                    .run(opts.stationId, ns.name, t, opts.userId);
            }
        }
        if (opts.employeeId !== undefined)
            await db.prepare("UPDATE users SET employee_id=?, updated_at=? WHERE id=?").run(opts.employeeId?.trim() || null, t, opts.userId);
        if (opts.phone !== undefined)
            await db.prepare("UPDATE users SET phone=?, updated_at=? WHERE id=?").run(opts.phone?.trim() || null, t, opts.userId);
        if (opts.email !== undefined)
            await db.prepare("UPDATE users SET email=?, updated_at=? WHERE id=?").run(opts.email?.trim() || null, t, opts.userId);
    });
    await audit(opts.managerId, "nurse_edit", null, { userId: opts.userId });
    return { ok: true };
}
export async function deleteNurse(userId, managerId) {
    const user = await db.prepare("SELECT id, role, name FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "NURSE")
        throw new HttpError(404, "Nurse not found");
    await db.prepare("DELETE FROM nurse_access_assignments WHERE nurse_id=?").run(userId);
    await db.prepare("DELETE FROM users WHERE id=?").run(userId);
    await audit(managerId, "nurse_delete", null, { userId, name: user.name });
    return { ok: true };
}
// ── Nursing station lifecycle ─────────────────────────────────────────────────
export async function listNursingStations() {
    return db.prepare(`SELECT ns.id, ns.name,
            COUNT(DISTINCT w.id)::int  AS ward_count,
            COUNT(DISTINCT u.id)::int  AS nurse_count
     FROM nursing_stations ns
     LEFT JOIN wards w ON w.station_id = ns.id
     LEFT JOIN users u ON u.station_id = ns.id AND u.role = 'NURSE'
     GROUP BY ns.id, ns.name
     ORDER BY ns.name`).all();
}
export async function createNursingStation(opts) {
    const name = opts.name.trim();
    if (!name)
        throw new HttpError(400, "Station name required");
    const t = now();
    try {
        const r = await db.prepare("INSERT INTO nursing_stations (name, created_at, updated_at) VALUES (?,?,?) RETURNING id").run(name, t, t);
        await audit(opts.managerId, "station_create", name, {});
        return { ok: true, id: Number(r.lastInsertRowid), name };
    }
    catch (err) {
        if (isUniqueViolation(err))
            throw new HttpError(409, `Station "${name}" already exists`);
        throw err;
    }
}
export async function editNursingStation(opts) {
    const name = opts.name.trim();
    if (!name)
        throw new HttpError(400, "Station name required");
    const ex = await db.prepare("SELECT id FROM nursing_stations WHERE id=?").get(opts.stationId);
    if (!ex)
        throw new HttpError(404, "Station not found");
    const t = now();
    try {
        await db.prepare("UPDATE nursing_stations SET name=?, updated_at=? WHERE id=?").run(name, t, opts.stationId);
    }
    catch (err) {
        if (isUniqueViolation(err))
            throw new HttpError(409, `Station name "${name}" already taken`);
        throw err;
    }
    await db.prepare("UPDATE wards SET nursing_station=? WHERE station_id=?").run(name, opts.stationId);
    await db.prepare("UPDATE users SET nursing_station=? WHERE station_id=?").run(name, opts.stationId);
    await audit(opts.managerId, "station_edit", name, { stationId: opts.stationId });
    return { ok: true };
}
export async function assignWardsToStation(stationId, wardIds, managerId) {
    const s = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
        .get(stationId);
    if (!s)
        throw new HttpError(404, "Station not found");
    const t = now();
    const currentWards = await db.prepare("SELECT id FROM wards WHERE station_id=?")
        .all(stationId);
    const currentWardIdSet = new Set(currentWards.map(w => w.id));
    const newWardIdSet = new Set(wardIds);
    // Wards removed from this station → delete this station's nurses' access to them
    for (const { id: wardId } of currentWards) {
        if (!newWardIdSet.has(wardId)) {
            await db.prepare(`DELETE FROM nurse_access_assignments
         WHERE ward_id=? AND nurse_id IN (SELECT id FROM users WHERE station_id=?)`).run(wardId, stationId);
        }
    }
    // Wards moved in from a different station → delete old station's nurses' access
    for (const wardId of wardIds) {
        if (!currentWardIdSet.has(wardId)) {
            const ward = await db.prepare("SELECT station_id FROM wards WHERE id=?")
                .get(wardId);
            if (ward?.station_id && ward.station_id !== stationId) {
                await db.prepare(`DELETE FROM nurse_access_assignments
           WHERE ward_id=? AND nurse_id IN (SELECT id FROM users WHERE station_id=?)`).run(wardId, ward.station_id);
            }
        }
    }
    // Clear and re-assign atomically so a mid-loop failure can't leave partial state
    await db.transaction(async () => {
        await db.prepare("UPDATE wards SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE station_id=?")
            .run(t, stationId);
        for (const wardId of wardIds) {
            await db.prepare("UPDATE wards SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
                .run(stationId, s.name, t, wardId);
        }
    });
    await audit(managerId, "station_assign_wards", s.name, { stationId, wardIds });
    return { ok: true };
}
export async function deleteNursingStation(stationId, managerId) {
    const s = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
        .get(stationId);
    if (!s)
        throw new HttpError(404, "Station not found");
    const t = now();
    // Unassign all wards and nurses before deleting; clean up their access assignments
    await db.prepare("DELETE FROM nurse_access_assignments WHERE ward_id IN (SELECT id FROM wards WHERE station_id=?)").run(stationId);
    await db.prepare("UPDATE wards SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE station_id=?").run(t, stationId);
    await db.prepare("UPDATE users SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE station_id=?").run(t, stationId);
    await db.prepare("DELETE FROM nursing_stations WHERE id=?").run(stationId);
    await audit(managerId, "station_delete", s.name, { stationId });
    return { ok: true };
}
// ── history ───────────────────────────────────────────────────────────────────
export async function availableDates() {
    // Postgres rejects DISTINCT + ORDER BY on a non-selected column; round_key
    // dates are YYYY-MM-DD so sorting them directly gives newest-first.
    const [roundRows, censusRows] = await Promise.all([
        db.prepare("SELECT DISTINCT SPLIT_PART(round_key, '|', 3) AS date FROM pre_rounds WHERE round_key LIKE '%|%|%|%'").all(),
        db.prepare("SELECT census_date FROM midnight_census").all(),
    ]);
    const dates = new Set([
        ...roundRows.map(r => r.date).filter(Boolean),
        ...censusRows.map(c => c.census_date),
    ]);
    return [...dates].sort().reverse();
}
// Rounds are submitted per PRE Block (pre_rounds.pre_block_id); floor_id is a
// legacy column that is NULL on all new rows.
export async function historyForDate(date, preBlockId) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new HttpError(400, "Invalid date format. Use YYYY-MM-DD.");
    let sql = `SELECT pr.pre_block_id, pb.name AS block_name,
            pr.shift, pr.start_min AS "startMin", pr.submitted_at AS "submittedAt", pr.snapshot
     FROM pre_rounds pr
     LEFT JOIN pre_blocks pb ON pb.id = pr.pre_block_id
     WHERE pr.round_key LIKE ?`;
    const params = [`%|${date}|%`];
    if (preBlockId !== undefined) {
        sql += " AND pr.pre_block_id=?";
        params.push(preBlockId);
    }
    sql += " ORDER BY pr.submitted_at";
    const rows = await db.prepare(sql).all(...params);
    return rows.map(r => ({
        preBlockId: r.pre_block_id,
        floorId: r.pre_block_id, // legacy alias for older clients
        floorCode: r.block_name || `PB${r.pre_block_id}`,
        blockName: r.block_name,
        floorName: r.block_name || `PRE Block ${r.pre_block_id}`,
        shift: r.shift,
        submittedAt: r.submittedAt,
        startMin: r.startMin,
        wards: (() => { try {
            return JSON.parse(r.snapshot || "[]");
        }
        catch {
            return [];
        } })(),
    }));
}
function parseNaa(r) {
    let beds = [];
    try {
        beds = JSON.parse(r.bed_names || "[]");
    }
    catch { /* corrupt */ }
    return { ...r, bed_names: beds };
}
export async function listNurseAccess(filters = {}) {
    let sql = `
    SELECT naa.id, naa.nurse_id, naa.ward_id, naa.access_type, naa.bed_names,
           naa.status, naa.created_at, naa.updated_at, naa.created_by,
           u.name AS nurse_name, u.username AS nurse_username, w.name AS ward_name
    FROM nurse_access_assignments naa
    JOIN users u ON u.id = naa.nurse_id
    JOIN wards w ON w.id = naa.ward_id
    WHERE 1=1`;
    const params = [];
    if (filters.nurseId !== undefined) {
        sql += " AND naa.nurse_id=?";
        params.push(filters.nurseId);
    }
    if (filters.wardId !== undefined) {
        sql += " AND naa.ward_id=?";
        params.push(filters.wardId);
    }
    if (filters.status) {
        sql += " AND naa.status=?";
        params.push(filters.status);
    }
    sql += " ORDER BY u.name, w.name";
    const rows = await db.prepare(sql).all(...params);
    return rows.map(parseNaa);
}
export async function createNurseAccess(opts) {
    const { nurseId, wardId, accessType, managerId } = opts;
    const bedNames = [...new Set(opts.bedNames ?? [])];
    if (accessType === "BEDS" && bedNames.length === 0)
        throw new HttpError(400, "Select at least one bed for Selected Beds access");
    const existing = await db.prepare("SELECT id, access_type FROM nurse_access_assignments WHERE nurse_id=? AND ward_id=?").get(nurseId, wardId);
    if (existing) {
        if (existing.access_type === "FULL")
            throw new HttpError(409, "This nurse already has Full Access to this ward");
        // existing is BEDS; upgrade to FULL or update beds
    }
    const t = now();
    const bedJson = JSON.stringify(accessType === "FULL" ? [] : bedNames);
    if (existing) {
        await db.prepare("UPDATE nurse_access_assignments SET access_type=?, bed_names=?, updated_at=?, created_by=? WHERE id=?").run(accessType, bedJson, t, managerId, existing.id);
        await audit(managerId, "nurse_access_update", null, { id: existing.id, nurseId, wardId, accessType });
        return { ok: true, id: existing.id };
    }
    const r = await db.prepare(`INSERT INTO nurse_access_assignments
       (nurse_id, ward_id, access_type, bed_names, status, created_at, updated_at, created_by)
     VALUES (?,?,?,?,'active',?,?,?) RETURNING id`).run(nurseId, wardId, accessType, bedJson, t, t, managerId);
    const id = Number(r.lastInsertRowid);
    await audit(managerId, "nurse_access_create", null, { id, nurseId, wardId, accessType });
    return { ok: true, id };
}
export async function editNurseAccess(opts) {
    const row = await db.prepare("SELECT id, access_type, bed_names, status FROM nurse_access_assignments WHERE id=?").get(opts.id);
    if (!row)
        throw new HttpError(404, "Assignment not found");
    const accessType = (opts.accessType ?? row.access_type);
    let beds;
    if (opts.bedNames !== undefined) {
        beds = [...new Set(opts.bedNames)];
    }
    else {
        try {
            beds = JSON.parse(row.bed_names || "[]");
        }
        catch {
            beds = [];
        }
    }
    if (accessType === "BEDS" && beds.length === 0)
        throw new HttpError(400, "Select at least one bed for Selected Beds access");
    const status = opts.status ?? row.status;
    const bedJson = JSON.stringify(accessType === "FULL" ? [] : beds);
    await db.prepare("UPDATE nurse_access_assignments SET access_type=?, bed_names=?, status=?, updated_at=? WHERE id=?").run(accessType, bedJson, status, now(), opts.id);
    await audit(opts.managerId, "nurse_access_edit", null, { id: opts.id, accessType, status });
    return { ok: true };
}
export async function deleteNurseAccess(id, managerId) {
    const row = await db.prepare("SELECT id, nurse_id, ward_id FROM nurse_access_assignments WHERE id=?").get(id);
    if (!row)
        throw new HttpError(404, "Assignment not found");
    await db.prepare("DELETE FROM nurse_access_assignments WHERE id=?").run(id);
    await audit(managerId, "nurse_access_delete", null, { id, nurseId: row.nurse_id, wardId: row.ward_id });
    return { ok: true };
}

import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
// ── helpers ───────────────────────────────────────────────────────────────────
/** Normalise a block name: trim + uppercase. "1a " → "1A" */
const normalizeBlock = (n) => n.trim().toUpperCase();
/** Find block by normalised name_key or throw 404. */
async function requireBlock(nameOrId) {
    const row = typeof nameOrId === "number"
        ? await db.prepare("SELECT id, name FROM blocks WHERE id = ?").get(nameOrId)
        : await db.prepare("SELECT id, name FROM blocks WHERE name_key = ?")
            .get(normalizeBlock(String(nameOrId)));
    if (!row)
        throw new HttpError(404, `Block "${nameOrId}" not found`);
    return row;
}
// ── BLOCK lifecycle ───────────────────────────────────────────────────────────
export async function listBlocks() {
    return db.prepare(`SELECT b.id, b.name, b.label, b.sort_order,
            u.id   AS user_id,
            u.name AS user_name,
            u.shift
     FROM blocks b
     LEFT JOIN users u ON u.block_id = b.id AND u.role = 'PRE'
     ORDER BY b.sort_order, b.name`).all();
}
export async function createBlock(opts) {
    const key = normalizeBlock(opts.name);
    if (!key)
        throw new HttpError(400, "Block name required");
    const existing = await db.prepare("SELECT id FROM blocks WHERE name_key = ?").get(key);
    if (existing)
        throw new HttpError(409, `Block "${key}" already exists`);
    const maxOrderRow = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM blocks")
        .get();
    const maxOrder = maxOrderRow.m;
    const now = Date.now();
    // RETURNING id so lastInsertRowid works in PostgreSQL
    const r = await db.prepare("INSERT INTO blocks (name, name_key, label, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?) RETURNING id").run(key, key, opts.label?.trim() || null, maxOrder + 1, now, now);
    await audit(opts.managerId, "block_create", key, { label: opts.label });
    return { ok: true, id: Number(r.lastInsertRowid), name: key };
}
export async function editBlock(opts) {
    const block = await requireBlock(opts.blockId);
    const now = Date.now();
    await db.transaction(async () => {
        if (opts.name !== undefined) {
            const key = normalizeBlock(opts.name);
            const clash = await db.prepare("SELECT id FROM blocks WHERE name_key = ? AND id != ?")
                .get(key, opts.blockId);
            if (clash)
                throw new HttpError(409, `Block name "${key}" already taken`);
            await db.prepare("UPDATE blocks SET name=?, name_key=?, updated_at=? WHERE id=?")
                .run(key, key, now, opts.blockId);
        }
        if (opts.label !== undefined)
            await db.prepare("UPDATE blocks SET label=?, updated_at=? WHERE id=?")
                .run(opts.label?.trim() || null, now, opts.blockId);
        if (opts.sortOrder !== undefined)
            await db.prepare("UPDATE blocks SET sort_order=?, updated_at=? WHERE id=?")
                .run(opts.sortOrder, now, opts.blockId);
    });
    await audit(opts.managerId, "block_edit", block.name, opts);
    return { ok: true };
}
export async function deleteBlock(blockId, managerId) {
    const block = await requireBlock(blockId);
    const wardCountRow = await db.prepare("SELECT COUNT(*) AS n FROM wards WHERE block_id = ?")
        .get(blockId);
    const wardCount = wardCountRow.n;
    if (wardCount > 0)
        throw new HttpError(409, `Block "${block.name}" has ${wardCount} ward(s). Remove them first.`);
    // Unassign any PRE users from this block
    await db.prepare("UPDATE users SET block_id = NULL WHERE block_id = ?").run(blockId);
    await db.prepare("DELETE FROM blocks WHERE id = ?").run(blockId);
    await audit(managerId, "block_delete", block.name, { blockId });
    return { ok: true };
}
// ── WARD lifecycle ────────────────────────────────────────────────────────────
export async function createWard(opts) {
    const block = await requireBlock(opts.blockId);
    const now = Date.now();
    const total = Math.max(0, Math.floor(opts.totalBeds));
    try {
        let wardId = 0;
        await db.transaction(async () => {
            const r = await db.prepare(`INSERT INTO wards (name, block_id, total_beds, nursing_station, unit_type, room_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`).run(opts.name.trim(), opts.blockId, total, opts.nursingStation?.trim() || null, opts.unitType?.trim() || null, opts.roomType?.trim() || null, now, now);
            wardId = Number(r.lastInsertRowid);
            await db.prepare("INSERT INTO beds (ward_id, total) VALUES (?,?)").run(wardId, total);
            if (total > 0) {
                const insBed = db.prepare("INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?)");
                for (let i = 1; i <= total; i++) {
                    await insBed.run(wardId, String(i), now, opts.managerId);
                }
            }
        });
        await audit(opts.managerId, "ward_create", block.name, { name: opts.name, totalBeds: total });
        return { ok: true, id: wardId };
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(409, `Ward "${opts.name}" already exists in block ${block.name}`);
    }
}
export async function editWard(opts) {
    const ward = await db.prepare("SELECT id, block_id FROM wards WHERE id = ?")
        .get(opts.wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    const block = await requireBlock(ward.block_id);
    const now = Date.now();
    await db.transaction(async () => {
        if (opts.name !== undefined)
            await db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?")
                .run(opts.name.trim(), now, opts.wardId);
        if (opts.totalBeds !== undefined) {
            const actualRow = await db.prepare("SELECT COUNT(*) AS c FROM bed_details WHERE ward_id=?").get(opts.wardId);
            const actual = actualRow?.c ?? 0;
            if (opts.totalBeds !== actual)
                throw new HttpError(409, `Capacity is derived from beds (currently ${actual}). ` +
                    `Add or delete beds to change it.`);
            await db.prepare("UPDATE wards SET updated_at=? WHERE id=?").run(now, opts.wardId);
        }
        if (opts.blockId !== undefined) {
            await requireBlock(opts.blockId);
            await db.prepare("UPDATE wards SET block_id=?, updated_at=? WHERE id=?")
                .run(opts.blockId, now, opts.wardId);
        }
        if (opts.nursingStation !== undefined)
            await db.prepare("UPDATE wards SET nursing_station=?, updated_at=? WHERE id=?")
                .run(opts.nursingStation?.trim() || null, now, opts.wardId);
        if (opts.unitType !== undefined)
            await db.prepare("UPDATE wards SET unit_type=?, updated_at=? WHERE id=?")
                .run(opts.unitType?.trim() || null, now, opts.wardId);
        if (opts.roomType !== undefined)
            await db.prepare("UPDATE wards SET room_type=?, updated_at=? WHERE id=?")
                .run(opts.roomType?.trim() || null, now, opts.wardId);
    });
    await audit(opts.managerId, "ward_edit", block.name, { wardId: opts.wardId, name: opts.name, totalBeds: opts.totalBeds, blockId: opts.blockId });
    return { ok: true };
}
export async function deleteWard(wardId, managerId) {
    const ward = await db.prepare("SELECT block_id FROM wards WHERE id = ?")
        .get(wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    const block = await requireBlock(ward.block_id);
    await db.prepare("DELETE FROM wards WHERE id = ?").run(wardId);
    await audit(managerId, "ward_delete", block.name, { wardId });
    return { ok: true };
}
// ── PRE user lifecycle ────────────────────────────────────────────────────────
export async function createPre(opts) {
    const username = opts.username.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username))
        throw new HttpError(400, "Username: letters, numbers, underscore only");
    if (await db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
        throw new HttpError(409, "Username already taken");
    // Validate block (if supplied)
    if (opts.blockId != null) {
        const existing = await db.prepare("SELECT id FROM users WHERE block_id=? AND role='PRE'")
            .get(opts.blockId);
        if (existing)
            throw new HttpError(409, "Another PRE user is already assigned to that block");
    }
    const now = Date.now();
    const shift = opts.shift || "morning";
    // RETURNING id so lastInsertRowid works in PostgreSQL
    const r = await db.prepare("INSERT INTO users (username,password_hash,role,name,shift,block_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id").run(username, bcrypt.hashSync(opts.password, 10), "PRE", opts.name, shift, opts.blockId ?? null, now, now);
    const blockNameRow = opts.blockId
        ? await db.prepare("SELECT name FROM blocks WHERE id=?").get(opts.blockId)
        : null;
    await audit(opts.managerId, "pre_create", blockNameRow?.name ?? "unassigned", { username, name: opts.name, shift, blockId: opts.blockId });
    return { ok: true, id: Number(r.lastInsertRowid), username };
}
export async function editPre(opts) {
    const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
        .get(opts.userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    if (opts.blockId !== undefined && opts.blockId !== null) {
        const clash = await db.prepare("SELECT id FROM users WHERE block_id=? AND role='PRE' AND id!=?").get(opts.blockId, opts.userId);
        if (clash)
            throw new HttpError(409, "Another PRE is already assigned to that block");
        await requireBlock(opts.blockId);
    }
    const now = Date.now();
    await db.transaction(async () => {
        if (opts.name !== undefined)
            await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, now, opts.userId);
        if (opts.password)
            await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
                .run(bcrypt.hashSync(opts.password, 10), now, opts.userId);
        if (opts.shift)
            await db.prepare("UPDATE users SET shift=?, updated_at=? WHERE id=?").run(opts.shift, now, opts.userId);
        if (opts.blockId !== undefined)
            await db.prepare("UPDATE users SET block_id=?, updated_at=? WHERE id=?")
                .run(opts.blockId, now, opts.userId);
    });
    await audit(opts.managerId, "pre_edit", null, { userId: opts.userId, name: opts.name, shift: opts.shift, blockId: opts.blockId });
    return { ok: true };
}
export async function setPreShift(userId, shift, managerId) {
    const user = await db.prepare("SELECT id,role FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    await db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, Date.now(), userId);
    await audit(managerId, "pre_shift", null, { userId, shift });
    return { ok: true, shift };
}
export async function deletePre(userId, managerId) {
    const user = await db.prepare("SELECT id,role,name,block_id FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    await db.prepare("DELETE FROM users WHERE id=?").run(userId);
    await audit(managerId, "pre_delete", null, { userId, name: user.name, blockId: user.block_id });
    return { ok: true };
}
// ── Nurse In-Charge lifecycle ─────────────────────────────────────────────────
export async function createNurse(opts) {
    const username = opts.username.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username))
        throw new HttpError(400, "Username: letters, numbers, underscore only");
    if (!opts.nursingStation.trim())
        throw new HttpError(400, "Nursing station is required for a Nurse account");
    if (await db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
        throw new HttpError(409, "Username already taken");
    const now = Date.now();
    const r = await db.prepare("INSERT INTO users (username,password_hash,role,name,shift,nursing_station,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id").run(username, bcrypt.hashSync(opts.password, 10), "NURSE", opts.name.trim(), "morning", opts.nursingStation.trim(), now, now);
    await audit(opts.managerId, "nurse_create", opts.nursingStation, { username, name: opts.name });
    return { ok: true, id: Number(r.lastInsertRowid), username };
}
export async function editNurse(opts) {
    const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
        .get(opts.userId);
    if (!user || user.role !== "NURSE")
        throw new HttpError(404, "Nurse not found");
    const now = Date.now();
    await db.transaction(async () => {
        if (opts.name !== undefined)
            await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, now, opts.userId);
        if (opts.password)
            await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
                .run(bcrypt.hashSync(opts.password, 10), now, opts.userId);
        if (opts.nursingStation !== undefined)
            await db.prepare("UPDATE users SET nursing_station=?, updated_at=? WHERE id=?")
                .run(opts.nursingStation.trim() || null, now, opts.userId);
    });
    await audit(opts.managerId, "nurse_edit", null, { userId: opts.userId });
    return { ok: true };
}
export async function deleteNurse(userId, managerId) {
    const user = await db.prepare("SELECT id, role, name FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "NURSE")
        throw new HttpError(404, "Nurse not found");
    await db.prepare("DELETE FROM users WHERE id=?").run(userId);
    await audit(managerId, "nurse_delete", null, { userId, name: user.name });
    return { ok: true };
}
// ── history ───────────────────────────────────────────────────────────────────
export async function availableDates() {
    const rows = await db.prepare("SELECT DISTINCT round_key FROM pre_rounds ORDER BY submitted_at DESC").all();
    const dates = new Set();
    for (const r of rows) {
        const parts = r.round_key.split("|");
        if (parts[2])
            dates.add(parts[2]);
    }
    return [...dates];
}
export async function historyForDate(date, blockId) {
    let sql = `SELECT pr.block_id, b.name AS block_name, pr.shift,
            pr.start_min AS startMin, pr.submitted_at AS submittedAt, pr.snapshot
     FROM pre_rounds pr
     LEFT JOIN blocks b ON b.id = pr.block_id
     WHERE pr.round_key LIKE ?`;
    const params = [`%|${date}|%`];
    if (blockId !== undefined) {
        sql += " AND pr.block_id=?";
        params.push(blockId);
    }
    sql += " ORDER BY pr.submitted_at";
    const rows = await db.prepare(sql).all(...params);
    return rows.map(r => ({
        blockId: r.block_id,
        blockName: r.block_name,
        shift: r.shift,
        startMin: r.startMin,
        submittedAt: r.submittedAt,
        wards: (() => { try {
            return JSON.parse(r.snapshot || "[]");
        }
        catch {
            return [];
        } })(),
    }));
}

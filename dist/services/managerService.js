import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
// ── helpers ───────────────────────────────────────────────────────────────────
/** Normalise a block name: trim + uppercase. "1a " → "1A" */
const normalizeBlock = (n) => n.trim().toUpperCase();
/** Find block by normalised name_key or throw 404. */
function requireBlock(nameOrId) {
    const row = typeof nameOrId === "number"
        ? db.prepare("SELECT id, name FROM blocks WHERE id = ?").get(nameOrId)
        : db.prepare("SELECT id, name FROM blocks WHERE name_key = ?")
            .get(normalizeBlock(String(nameOrId)));
    if (!row)
        throw new HttpError(404, `Block "${nameOrId}" not found`);
    return row;
}
// ── BLOCK lifecycle ───────────────────────────────────────────────────────────
export function listBlocks() {
    return db.prepare(`SELECT b.id, b.name, b.label, b.sort_order,
            u.id   AS user_id,
            u.name AS user_name,
            u.shift
     FROM blocks b
     LEFT JOIN users u ON u.block_id = b.id AND u.role = 'PRE'
     ORDER BY b.sort_order, b.name`).all();
}
export function createBlock(opts) {
    const key = normalizeBlock(opts.name);
    if (!key)
        throw new HttpError(400, "Block name required");
    const existing = db.prepare("SELECT id FROM blocks WHERE name_key = ?").get(key);
    if (existing)
        throw new HttpError(409, `Block "${key}" already exists`);
    const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM blocks")
        .get().m;
    const now = Date.now();
    const r = db.prepare("INSERT INTO blocks (name, name_key, label, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(key, key, opts.label?.trim() || null, maxOrder + 1, now, now);
    audit(opts.managerId, "block_create", key, { label: opts.label });
    return { ok: true, id: Number(r.lastInsertRowid), name: key };
}
export function editBlock(opts) {
    const block = requireBlock(opts.blockId);
    const now = Date.now();
    db.transaction(() => {
        if (opts.name !== undefined) {
            const key = normalizeBlock(opts.name);
            const clash = db.prepare("SELECT id FROM blocks WHERE name_key = ? AND id != ?")
                .get(key, opts.blockId);
            if (clash)
                throw new HttpError(409, `Block name "${key}" already taken`);
            db.prepare("UPDATE blocks SET name=?, name_key=?, updated_at=? WHERE id=?")
                .run(key, key, now, opts.blockId);
        }
        if (opts.label !== undefined)
            db.prepare("UPDATE blocks SET label=?, updated_at=? WHERE id=?")
                .run(opts.label?.trim() || null, now, opts.blockId);
        if (opts.sortOrder !== undefined)
            db.prepare("UPDATE blocks SET sort_order=?, updated_at=? WHERE id=?")
                .run(opts.sortOrder, now, opts.blockId);
    });
    audit(opts.managerId, "block_edit", block.name, opts);
    return { ok: true };
}
export function deleteBlock(blockId, managerId) {
    const block = requireBlock(blockId);
    const wardCount = db.prepare("SELECT COUNT(*) AS n FROM wards WHERE block_id = ?")
        .get(blockId).n;
    if (wardCount > 0)
        throw new HttpError(409, `Block "${block.name}" has ${wardCount} ward(s). Remove them first.`);
    // Unassign any PRE users from this block
    db.prepare("UPDATE users SET block_id = NULL WHERE block_id = ?").run(blockId);
    db.prepare("DELETE FROM blocks WHERE id = ?").run(blockId);
    audit(managerId, "block_delete", block.name, { blockId });
    return { ok: true };
}
// ── WARD lifecycle ────────────────────────────────────────────────────────────
export function createWard(opts) {
    const block = requireBlock(opts.blockId);
    const now = Date.now();
    const total = Math.max(0, Math.floor(opts.totalBeds));
    try {
        let wardId = 0;
        db.transaction(() => {
            const r = db.prepare("INSERT INTO wards (name, block_id, total_beds, created_at, updated_at) VALUES (?,?,?,?,?)").run(opts.name.trim(), opts.blockId, total, now, now);
            wardId = Number(r.lastInsertRowid);
            db.prepare("INSERT INTO beds (ward_id, total) VALUES (?,?)").run(wardId, total);
            // Auto-create bed_details rows numbered 1..N (VACANT). bed_details is now
            // the source of truth for capacity, so the ward's bed_details count must
            // match the totalBeds the manager declared at creation time.
            if (total > 0) {
                const insBed = db.prepare("INSERT INTO bed_details (ward_id, bed_number, status, updated_at, updated_by) VALUES (?,?,?,?,?)");
                for (let i = 1; i <= total; i++) {
                    insBed.run(wardId, String(i), "VACANT", now, opts.managerId);
                }
            }
        });
        audit(opts.managerId, "ward_create", block.name, { name: opts.name, totalBeds: total });
        return { ok: true, id: wardId };
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(409, `Ward "${opts.name}" already exists in block ${block.name}`);
    }
}
export function editWard(opts) {
    const ward = db.prepare("SELECT id, block_id FROM wards WHERE id = ?")
        .get(opts.wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    const block = requireBlock(ward.block_id);
    const now = Date.now();
    db.transaction(() => {
        if (opts.name !== undefined)
            db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?")
                .run(opts.name.trim(), now, opts.wardId);
        if (opts.totalBeds !== undefined) {
            // Capacity is now derived from bed_details. Reject any edit that doesn't
            // match the current actual count — managers must add/delete individual
            // beds via the bed endpoints to change capacity.
            const actual = db.prepare("SELECT COUNT(*) AS c FROM bed_details WHERE ward_id=?").get(opts.wardId)?.c ?? 0;
            if (opts.totalBeds !== actual)
                throw new HttpError(409, `Capacity is derived from beds (currently ${actual}). ` +
                    `Add or delete beds to change it.`);
            // Matches — no-op write, but bump updated_at for consistency
            db.prepare("UPDATE wards SET updated_at=? WHERE id=?").run(now, opts.wardId);
        }
        if (opts.blockId !== undefined) {
            requireBlock(opts.blockId); // validate target block exists
            db.prepare("UPDATE wards SET block_id=?, updated_at=? WHERE id=?")
                .run(opts.blockId, now, opts.wardId);
        }
    });
    audit(opts.managerId, "ward_edit", block.name, { wardId: opts.wardId, name: opts.name, totalBeds: opts.totalBeds, blockId: opts.blockId });
    return { ok: true };
}
export function deleteWard(wardId, managerId) {
    const ward = db.prepare("SELECT block_id FROM wards WHERE id = ?")
        .get(wardId);
    if (!ward)
        throw new HttpError(404, "Ward not found");
    const block = requireBlock(ward.block_id);
    db.prepare("DELETE FROM wards WHERE id = ?").run(wardId);
    audit(managerId, "ward_delete", block.name, { wardId });
    return { ok: true };
}
// ── PRE user lifecycle ────────────────────────────────────────────────────────
export function createPre(opts) {
    const username = opts.username.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username))
        throw new HttpError(400, "Username: letters, numbers, underscore only");
    if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
        throw new HttpError(409, "Username already taken");
    // Validate block (if supplied)
    if (opts.blockId != null) {
        const existing = db.prepare("SELECT id FROM users WHERE block_id=? AND role='PRE'")
            .get(opts.blockId);
        if (existing)
            throw new HttpError(409, "Another PRE user is already assigned to that block");
    }
    const now = Date.now();
    const shift = opts.shift || "morning";
    const r = db.prepare("INSERT INTO users (username,password_hash,role,name,shift,block_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(username, bcrypt.hashSync(opts.password, 10), "PRE", opts.name, shift, opts.blockId ?? null, now, now);
    const blockName = opts.blockId
        ? db.prepare("SELECT name FROM blocks WHERE id=?").get(opts.blockId)?.name
        : null;
    audit(opts.managerId, "pre_create", blockName ?? "unassigned", { username, name: opts.name, shift, blockId: opts.blockId });
    return { ok: true, id: Number(r.lastInsertRowid), username };
}
export function editPre(opts) {
    const user = db.prepare("SELECT id, role FROM users WHERE id=?")
        .get(opts.userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    if (opts.blockId !== undefined && opts.blockId !== null) {
        // Make sure no other PRE is already on that block
        const clash = db.prepare("SELECT id FROM users WHERE block_id=? AND role='PRE' AND id!=?").get(opts.blockId, opts.userId);
        if (clash)
            throw new HttpError(409, "Another PRE is already assigned to that block");
        requireBlock(opts.blockId);
    }
    const now = Date.now();
    db.transaction(() => {
        if (opts.name !== undefined)
            db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, now, opts.userId);
        if (opts.password)
            db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
                .run(bcrypt.hashSync(opts.password, 10), now, opts.userId);
        if (opts.shift)
            db.prepare("UPDATE users SET shift=?, updated_at=? WHERE id=?").run(opts.shift, now, opts.userId);
        if (opts.blockId !== undefined)
            db.prepare("UPDATE users SET block_id=?, updated_at=? WHERE id=?")
                .run(opts.blockId, now, opts.userId);
    });
    audit(opts.managerId, "pre_edit", null, { userId: opts.userId, name: opts.name, shift: opts.shift, blockId: opts.blockId });
    return { ok: true };
}
export function setPreShift(userId, shift, managerId) {
    const user = db.prepare("SELECT id,role FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, Date.now(), userId);
    audit(managerId, "pre_shift", null, { userId, shift });
    return { ok: true, shift };
}
export function deletePre(userId, managerId) {
    const user = db.prepare("SELECT id,role,name,block_id FROM users WHERE id=?")
        .get(userId);
    if (!user || user.role !== "PRE")
        throw new HttpError(404, "PRE not found");
    db.prepare("DELETE FROM users WHERE id=?").run(userId);
    audit(managerId, "pre_delete", null, { userId, name: user.name, blockId: user.block_id });
    return { ok: true };
}
// ── history ───────────────────────────────────────────────────────────────────
export function availableDates() {
    const rows = db.prepare("SELECT DISTINCT round_key FROM pre_rounds ORDER BY submitted_at DESC").all();
    const dates = new Set();
    for (const r of rows) {
        const parts = r.round_key.split("|");
        if (parts[2])
            dates.add(parts[2]);
    }
    return [...dates];
}
export function historyForDate(date, blockId) {
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
    return db.prepare(sql).all(...params).map(r => ({
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

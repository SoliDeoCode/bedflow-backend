import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { deleteBed } from "./bedDetailService.js";

const now = () => Date.now();

function isUniqueViolation(err: unknown): boolean {
  return /unique/i.test(String((err as { message?: string })?.message ?? ""));
}

const ROLE_LABEL: Record<string, string> = {
  PRE: "PRE", NURSE: "Nurse", COO: "Admin", DOCTOR: "Doctor", FC: "FC", CONSULTANT: "Consultant",
};

export async function guardUniqueUsername(username: string) {
  const existing = await db.prepare("SELECT role FROM users WHERE username=?")
    .get<{ role: string }>(username);
  if (existing) {
    const label = ROLE_LABEL[existing.role] || existing.role;
    throw new HttpError(409, `Username "${username}" is already in use by a ${label} account.`);
  }
}

// Format a list of names for a user-facing message: "A", "A" and "B",
// "A", "B" and "C" (caps the list so the message stays readable).
function quoteList(names: string[], max = 4): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`);
  const extra = names.length - shown.length;
  const tail = extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.length > 1
    ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
    : shown[0] ?? "";
  return tail;
}

// Combine multiple independent blocking reasons into one sentence fragment, so
// a delete guard can report ALL reasons at once instead of only the first one
// found (which would otherwise force the manager to fix issues one at a time,
// hitting a new 409 on every retry): "A"; "A and B"; "A; B and C".
function joinClauses(clauses: string[]): string {
  return clauses.length > 1
    ? `${clauses.slice(0, -1).join("; ")} and ${clauses[clauses.length - 1]}`
    : clauses[0] ?? "";
}

// ── BUILDING BLOCKS (Block A / Block B …) ────────────────────────────────────

export async function listBuildingBlocks() {
  return db.prepare(
    `SELECT bb.id, bb.name, bb.label, bb.sort_order,
            COUNT(f.id)::int AS floor_count
     FROM building_blocks bb
     LEFT JOIN floors f ON f.building_block_id = bb.id
     GROUP BY bb.id, bb.name, bb.label, bb.sort_order
     ORDER BY bb.sort_order, bb.name`
  ).all<{ id: number; name: string; label: string | null; sort_order: number; floor_count: number }>();
}

export async function createBuildingBlock(opts: {
  name: string; label?: string; managerId: number;
}) {
  const name = opts.name.trim().toUpperCase();
  if (!name) throw new HttpError(400, "Block name required");
  const t = now();
  let r: { lastInsertRowid: number };
  try {
    r = await db.transaction(async () => {
      const next = (await db.prepare(
        "SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM building_blocks"
      ).get<{ n: number }>())!.n;
      return db.prepare(
        "INSERT INTO building_blocks (name, label, sort_order, created_at, updated_at) VALUES (?,?,?,?,?) RETURNING id"
      ).run(name, opts.label?.trim() || `Block ${name}`, next, t, t);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `Block "${name}" already exists`);
    throw err;
  }
  await audit(opts.managerId, "building_block_create", name, {});
  return { ok: true, id: Number(r.lastInsertRowid), name };
}

export async function editBuildingBlock(opts: {
  blockId: number; name?: string; label?: string; sortOrder?: number; managerId: number;
}) {
  const existing = await db.prepare("SELECT id, name FROM building_blocks WHERE id=?")
    .get<{ id: number; name: string }>(opts.blockId);
  if (!existing) throw new HttpError(404, "Building block not found");
  const t = now();
  if (opts.name !== undefined) {
    const n = opts.name.trim().toUpperCase();
    try {
      await db.prepare("UPDATE building_blocks SET name=?, updated_at=? WHERE id=?").run(n, t, opts.blockId);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, `Block "${n}" already exists`);
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

export async function deleteBuildingBlock(blockId: number, managerId: number) {
  const b = await db.prepare("SELECT id, name FROM building_blocks WHERE id=?")
    .get<{ id: number; name: string }>(blockId);
  if (!b) throw new HttpError(404, "Building block not found");
  const fc = (await db.prepare("SELECT COUNT(*) AS n FROM floors WHERE building_block_id=?")
    .get<{n: number}>(blockId))!.n;
  if (fc > 0) throw new HttpError(409, `Block "${b.name}" has ${fc} floor(s). Remove them first.`);
  await db.prepare("DELETE FROM building_blocks WHERE id=?").run(blockId);
  await audit(managerId, "building_block_delete", b.name, { blockId });
  return { ok: true };
}

// ── FLOORS ────────────────────────────────────────────────────────────────────

export async function listFloors() {
  return db.prepare(
    `SELECT f.id, f.name, f.building_block_id, f.sort_order,
            bb.name AS block_name, bb.label AS block_label,
            (SELECT COUNT(*)::int FROM wards w WHERE w.floor_id = f.id) AS ward_count,
            (SELECT id   FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_id,
            (SELECT name FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_name
     FROM floors f
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     ORDER BY bb.sort_order, bb.name, f.sort_order, f.name`
  ).all();
}

export async function createFloor(opts: {
  name: string; buildingBlockId: number; managerId: number;
}) {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Floor name required");
  const bb = await db.prepare("SELECT id, name FROM building_blocks WHERE id=?")
    .get<{ id: number; name: string }>(opts.buildingBlockId);
  if (!bb) throw new HttpError(404, "Building block not found");

  const t = now();
  let r: { lastInsertRowid: number };
  try {
    r = await db.transaction(async () => {
      const next = (await db.prepare(
        "SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM floors WHERE building_block_id=?"
      ).get<{ n: number }>(opts.buildingBlockId))!.n;
      return db.prepare(
        "INSERT INTO floors (name, code, block_label, building_block_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id"
      ).run(name, name.replace(/\s+/g, "").substring(0, 20).toUpperCase(),
            bb.name, opts.buildingBlockId, next, t, t);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `A floor named "${name}" already exists in Block ${bb.name}`);
    throw err;
  }
  await audit(opts.managerId, "floor_create", `${bb.name}-${name}`, {});
  return { ok: true, id: Number(r.lastInsertRowid), name };
}

export async function editFloor(opts: {
  floorId: number; name: string; managerId: number;
}) {
  const floor = await db.prepare("SELECT id, name FROM floors WHERE id=?")
    .get<{ id: number; name: string }>(opts.floorId);
  if (!floor) throw new HttpError(404, "Floor not found");
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Floor name required");
  const t = now();
  try {
    await db.prepare("UPDATE floors SET name=?, code=?, updated_at=? WHERE id=?")
      .run(name, name.replace(/\s+/g, "").substring(0, 20).toUpperCase(), t, opts.floorId);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "A floor with a similar name already exists in this block");
    throw err;
  }
  await audit(opts.managerId, "floor_edit", name, { floorId: opts.floorId });
  return { ok: true };
}

export async function deleteFloor(floorId: number, managerId: number) {
  const floor = await db.prepare("SELECT id, name FROM floors WHERE id=?")
    .get<{ id: number; name: string }>(floorId);
  if (!floor) throw new HttpError(404, "Floor not found");
  const wc = (await db.prepare("SELECT COUNT(*) AS n FROM wards WHERE floor_id=?")
    .get<{n: number}>(floorId))!.n;
  if (wc > 0) throw new HttpError(409, `"${floor.name}" still has ${wc} ward(s). Remove them first.`);
  await db.prepare("UPDATE users SET floor_id=NULL WHERE floor_id=?").run(floorId);
  await db.prepare("DELETE FROM floors WHERE id=?").run(floorId);
  await audit(managerId, "floor_delete", floor.name, { floorId });
  return { ok: true };
}

// ── WARD lifecycle ────────────────────────────────────────────────────────────

export async function createWard(opts: {
  name: string; floorId: number; totalBeds: number; managerId: number;
  stationId?: number | null; unitType?: string; roomType?: string;
  bedType?: string; operational?: boolean;
}) {
  const floor = await db.prepare("SELECT id, name FROM floors WHERE id=?")
    .get<{ id: number; name: string }>(opts.floorId);
  if (!floor) throw new HttpError(404, "Floor not found");

  let stationName: string | null = null;
  if (opts.stationId) {
    const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
      .get<{ name: string }>(opts.stationId);
    if (!ns) throw new HttpError(404, "Nursing station not found");
    stationName = ns.name;
  }

  const total      = Math.max(0, Math.floor(opts.totalBeds));
  const bedType    = opts.bedType    ?? "Census";
  const operational = opts.operational ?? true;
  const t = now();
  try {
    let wardId = 0;
    await db.transaction(async () => {
      const r = await db.prepare(
        `INSERT INTO wards (name, floor_id, total_beds, nursing_station, station_id, unit_type, room_type, bed_type, operational, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
      ).run(opts.name.trim(), opts.floorId, total, stationName,
            opts.stationId ?? null, opts.unitType?.trim() || null,
            opts.roomType?.trim() || null, bedType, operational, t, t);
      wardId = Number(r.lastInsertRowid);
      await db.prepare("INSERT INTO beds (ward_id, total, vacant, reserved, occupied, occupied_reserved) VALUES (?,?,?,0,0,0)").run(wardId, total, total);
      if (total > 0) {
        const placeholders = Array.from({ length: total }, () => "(?,?,'VACANT','NONE',?,?,?,?)").join(",");
        const values: unknown[] = [];
        for (let i = 1; i <= total; i++) values.push(wardId, String(i), bedType, operational, t, opts.managerId);
        await db.prepare(
          `INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, updated_at, updated_by) VALUES ${placeholders}`
        ).run(...values);
      }
    });
    await audit(opts.managerId, "ward_create", floor.name, { name: opts.name, totalBeds: total, bedType, operational });
    return { ok: true, id: wardId };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, `Ward "${opts.name}" already exists on this floor`);
  }
}

// saved_views.selected_wards stores ward NAMES (JSON array), not ids — a rename
// would otherwise silently drop the ward out of every saved view that lists it.
async function renameWardInSavedViews(oldName: string, newName: string) {
  const escaped = oldName.replace(/[%_\\]/g, "\\$&");
  const rows = await db.prepare(
    "SELECT id, selected_wards FROM saved_views WHERE selected_wards LIKE ? ESCAPE '\\'"
  ).all<{ id: number; selected_wards: string }>(`%${escaped}%`);
  for (const row of rows) {
    let wards: unknown;
    try { wards = JSON.parse(row.selected_wards || "[]"); } catch { continue; }
    if (!Array.isArray(wards) || !wards.includes(oldName)) continue;
    const updated = wards.map((w) => (w === oldName ? newName : w));
    await db.prepare("UPDATE saved_views SET selected_wards=? WHERE id=?")
      .run(JSON.stringify(updated), row.id);
  }
}

export async function editWard(opts: {
  wardId: number; name?: string; totalBeds?: number; floorId?: number; managerId: number;
  stationId?: number | null; unitType?: string | null; roomType?: string | null;
  bedType?: string | null; operational?: boolean | null;
}) {
  const ward = await db.prepare("SELECT id, name, floor_id, operational FROM wards WHERE id=?")
    .get<{ id: number; name: string; floor_id: number; operational: boolean }>(opts.wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  const t = now();

  // Prevent marking a ward non-operational while it belongs to an active PRE block
  if (opts.operational === false) {
    const inBlock = await db.prepare(
      `SELECT pb.name FROM pre_block_wards pbw
       JOIN pre_blocks pb ON pb.id = pbw.pre_block_id
       WHERE pbw.ward_id = ?`
    ).get<{ name: string }>(opts.wardId);
    if (inBlock)
      throw new HttpError(409, `Remove this ward from PRE Block "${inBlock.name}" before marking it non-operational.`);
  }

  // Validate totalBeds before entering the transaction so other fields aren't silently skipped
  if (opts.totalBeds !== undefined) {
    const actual = (await db.prepare("SELECT COUNT(*) AS c FROM bed_details WHERE ward_id=?")
      .get<{c:number}>(opts.wardId))?.c ?? 0;
    if (opts.totalBeds !== actual)
      throw new HttpError(409, `Capacity is derived from beds (currently ${actual}). Add or delete beds to change it.`);
  }

  await db.transaction(async () => {
    if (opts.name !== undefined) {
      const trimmedName = opts.name.trim();
      await db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?")
        .run(trimmedName, t, opts.wardId);
      if (trimmedName !== ward.name) await renameWardInSavedViews(ward.name, trimmedName);
    }
    if (opts.totalBeds !== undefined) {
      await db.prepare("UPDATE wards SET updated_at=? WHERE id=?").run(t, opts.wardId);
    }
    if (opts.floorId !== undefined) {
      const f = await db.prepare("SELECT id FROM floors WHERE id=?").get<{id:number}>(opts.floorId);
      if (!f) throw new HttpError(404, "Floor not found");
      await db.prepare("UPDATE wards SET floor_id=?, updated_at=? WHERE id=?").run(opts.floorId, t, opts.wardId);
    }
    if (opts.stationId !== undefined) {
      let sName: string | null = null;
      if (opts.stationId) {
        const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
          .get<{name:string}>(opts.stationId);
        if (!ns) throw new HttpError(404, "Nursing station not found");
        sName = ns.name;
      }
      const prevStation = await db.prepare("SELECT station_id FROM wards WHERE id=?")
        .get<{ station_id: number | null }>(opts.wardId);
      // Ward is leaving its old station — drop that station's nurses' access to it,
      // otherwise nurse_access_assignments keeps pointing at a ward they no longer cover.
      if (prevStation?.station_id && prevStation.station_id !== opts.stationId) {
        await db.prepare(
          `DELETE FROM nurse_access_assignments
           WHERE ward_id=? AND nurse_id IN (SELECT id FROM users WHERE station_id=?)`
        ).run(opts.wardId, prevStation.station_id);
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
    if (opts.bedType != null) {
      await db.prepare("UPDATE wards SET bed_type=?, updated_at=? WHERE id=?")
        .run(opts.bedType, t, opts.wardId);
      // Census/Non-Census is ward-level only — no per-bed override exists anymore,
      // so every existing bed in this ward must follow the ward's new type too.
      // Without this, a ward edit would silently leave its beds mismatched.
      await db.prepare("UPDATE bed_details SET bed_type=?, updated_at=? WHERE ward_id=?")
        .run(opts.bedType, t, opts.wardId);
    }
    if (opts.operational != null) {
      await db.prepare("UPDATE wards SET operational=?, updated_at=? WHERE id=?")
        .run(opts.operational, t, opts.wardId);
      await db.prepare(
        `INSERT INTO ward_operational_log (ward_id, ward_name, changed_by, changed_at, old_value, new_value)
         VALUES (?,?,?,?,?,?)`
      ).run(opts.wardId, ward.name, opts.managerId, t, ward.operational, opts.operational);
    }
  });

  const floorName = ward.floor_id
    ? (await db.prepare("SELECT name FROM floors WHERE id=?").get<{name:string}>(ward.floor_id))?.name
    : "unknown";
  await audit(opts.managerId, "ward_edit", floorName ?? "unknown", { wardId: opts.wardId });
  return { ok: true };
}

export async function deleteWard(wardId: number, managerId: number) {
  const ward = await db.prepare("SELECT id, name, floor_id FROM wards WHERE id=?")
    .get<{ id: number; name: string; floor_id: number }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");

  // Guard against silent data loss: pre_block_wards.ward_id, nurse_access_assignments.ward_id,
  // and doctor_block_wards.ward_id all cascade ON DELETE, so deleting the ward
  // would quietly strip it from its PRE block, any nurse's access, and any
  // Doctor Block. Check ALL three up front (not just the first match) so the
  // manager sees every reason at once instead of hitting a new 409 on every retry.
  const blockers: string[] = [];

  const preBlocks = await db.prepare(
    `SELECT pb.name FROM pre_block_wards pbw
       JOIN pre_blocks pb ON pb.id = pbw.pre_block_id
      WHERE pbw.ward_id = ? ORDER BY pb.name`
  ).all<{ name: string }>(wardId);
  if (preBlocks.length)
    blockers.push(`part of PRE Block ${quoteList(preBlocks.map(b => b.name))}`);

  const nurses = await db.prepare(
    `SELECT DISTINCT u.name FROM nurse_access_assignments na
       JOIN users u ON u.id = na.nurse_id
      WHERE na.ward_id = ? AND na.status = 'active' ORDER BY u.name`
  ).all<{ name: string }>(wardId);
  if (nurses.length)
    blockers.push(`assigned to nurse ${quoteList(nurses.map(n => n.name))}`);

  const doctorBlocks = await db.prepare(
    `SELECT db.name FROM doctor_block_wards dbw
       JOIN doctor_blocks db ON db.id = dbw.doctor_block_id
      WHERE dbw.ward_id = ? ORDER BY db.name`
  ).all<{ name: string }>(wardId);
  if (doctorBlocks.length)
    blockers.push(`part of Doctor Block ${quoteList(doctorBlocks.map(b => b.name))}`);

  // bed_details.ward_id cascades ON DELETE too — refuse while any bed in the
  // ward is OCCUPIED (a live patient), the same "blocked while in use" rule
  // deletePayerType already applies. Vacant beds are not blocked: they're
  // auto-deleted just below via the normal per-bed path, so each one is still
  // properly tombstoned into bed_movements instead of silently cascading away.
  const occupiedBeds = await db.prepare(
    "SELECT bed_name FROM bed_details WHERE ward_id=? AND physical_status='OCCUPIED' ORDER BY bed_name"
  ).all<{ bed_name: string }>(wardId);
  if (occupiedBeds.length)
    blockers.push(`currently holding ${occupiedBeds.length} occupied bed${occupiedBeds.length > 1 ? "s" : ""} (${quoteList(occupiedBeds.map(b => b.bed_name))})`);

  if (blockers.length)
    throw new HttpError(409,
      `Ward "${ward.name}" is ${joinClauses(blockers)}. Remove these before deleting the ward.`);

  // No occupied beds remain (checked above) — any beds still here are vacant.
  // Delete them through the normal per-bed path so each gets a proper
  // bed_movements tombstone, instead of letting the ward delete cascade them
  // away with no record at all.
  const remainingBeds = await db.prepare("SELECT id FROM bed_details WHERE ward_id=?")
    .all<{ id: number }>(wardId);
  for (const b of remainingBeds) await deleteBed({ bedId: b.id, userId: managerId });

  await db.prepare("DELETE FROM wards WHERE id=?").run(wardId);
  await audit(managerId, "ward_delete", ward.name, { wardId, autoDeletedBeds: remainingBeds.length });
  return { ok: true, deletedBeds: remainingBeds.length };
}

// ── PRE user lifecycle ────────────────────────────────────────────────────────

export async function createPre(opts: {
  username: string; password: string; name: string;
  preBlockIds?: number[]; managerId: number;
}) {
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username))
    throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
  await guardUniqueUsername(username);

  const blockIds = opts.preBlockIds ?? [];
  for (const pbId of blockIds) {
    const pb = await db.prepare("SELECT name FROM pre_blocks WHERE id=?").get<{name:string}>(pbId);
    if (!pb) throw new HttpError(404, `PRE Block ${pbId} not found`);
  }

  const t = now();
  const r = await db.prepare(
    "INSERT INTO users (username,password_hash,role,name,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id"
  ).run(username, bcrypt.hashSync(opts.password, 10), "PRE", opts.name, t, t);
  const userId = Number(r.lastInsertRowid);

  for (const pbId of blockIds)
    await db.prepare("INSERT INTO user_pre_blocks (user_id, pre_block_id, created_at) VALUES (?,?,?)")
      .run(userId, pbId, t);

  const blockNames = blockIds.length
    ? (await Promise.all(blockIds.map(id =>
        db.prepare("SELECT name FROM pre_blocks WHERE id=?").get<{name:string}>(id)
          .then(r => r?.name ?? String(id))
      ))).join(", ")
    : "unassigned";
  await audit(opts.managerId, "pre_create", blockNames, { username, name: opts.name });
  return { ok: true, id: userId, username };
}

export async function editPre(opts: {
  userId: number; name?: string; password?: string;
  preBlockIds?: number[]; managerId: number;
}) {
  const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
    .get<{id: number; role: string}>(opts.userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE user not found.");

  if (opts.preBlockIds !== undefined) {
    for (const pbId of opts.preBlockIds) {
      const pb = await db.prepare("SELECT id FROM pre_blocks WHERE id=?").get<{id:number}>(pbId);
      if (!pb) throw new HttpError(404, `PRE Block ${pbId} not found`);
    }
  }

  const t = now();
  await db.transaction(async () => {
    if (opts.name !== undefined)
      await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, t, opts.userId);
    if (opts.password)
      await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
        .run(bcrypt.hashSync(opts.password, 10), t, opts.userId);
    if (opts.preBlockIds !== undefined) {
      await db.prepare("DELETE FROM user_pre_blocks WHERE user_id=?").run(opts.userId);
      for (const pbId of opts.preBlockIds)
        await db.prepare("INSERT INTO user_pre_blocks (user_id, pre_block_id, created_at) VALUES (?,?,?)")
          .run(opts.userId, pbId, t);
    }
  });
  await audit(opts.managerId, "pre_edit", null, { userId: opts.userId });
  return { ok: true };
}

export async function deletePre(userId: number, managerId: number) {
  const user = await db.prepare("SELECT id,role,name,floor_id FROM users WHERE id=?")
    .get<{id: number; role: string; name: string; floor_id: number | null}>(userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE user not found.");
  await db.prepare("DELETE FROM users WHERE id=?").run(userId);
  await audit(managerId, "pre_delete", null, { userId, name: user.name });
  return { ok: true };
}

// ── Nurse In-Charge lifecycle ─────────────────────────────────────────────────

async function validateStationIds(stationIds: number[]): Promise<Map<number, string>> {
  if (stationIds.length === 0) return new Map();
  const rows = await db.prepare("SELECT id, name FROM nursing_stations WHERE id = ANY(?)")
    .all<{ id: number; name: string }>(stationIds);
  const map = new Map(rows.map(r => [r.id, r.name]));
  const missing = stationIds.filter(id => !map.has(id));
  if (missing.length) throw new HttpError(404, `Nursing station not found: ${missing.join(", ")}`);
  return map;
}

/** Replace-all: a nurse's full set of stations becomes exactly stationIds. Also
 *  refreshes the legacy single station_id/nursing_station "primary" columns
 *  (first id in the list, or NULL) so old display code keeps working. */
async function setNurseStations(nurseId: number, stationIdsIn: number[], t: number) {
  const stationIds = [...new Set(stationIdsIn)];
  const nameById = await validateStationIds(stationIds);
  await db.prepare("DELETE FROM nurse_stations WHERE nurse_id=?").run(nurseId);
  for (const id of stationIds) {
    await db.prepare("INSERT INTO nurse_stations (nurse_id, station_id, created_at) VALUES (?,?,?)")
      .run(nurseId, id, t);
  }
  const primaryId   = stationIds[0] ?? null;
  const primaryName = primaryId != null ? nameById.get(primaryId)! : null;
  await db.prepare("UPDATE users SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
    .run(primaryId, primaryName, t, nurseId);
  return nameById;
}

export async function createNurse(opts: {
  username: string; password: string; name: string;
  stationIds?: number[]; managerId: number;
  employeeId?: string; phone?: string; email?: string;
}) {
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username))
    throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
  await guardUniqueUsername(username);

  const stationIds = [...new Set(opts.stationIds ?? [])];
  const nameById = await validateStationIds(stationIds);
  const primaryId   = stationIds[0] ?? null;
  const primaryName = primaryId != null ? nameById.get(primaryId)! : null;

  const t = now();
  let nurseId = 0;
  await db.transaction(async () => {
    const r = await db.prepare(
      `INSERT INTO users
         (username,password_hash,role,name,nursing_station,station_id,
          employee_id,phone,email,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
    ).run(username, bcrypt.hashSync(opts.password, 10), "NURSE", opts.name.trim(),
          primaryName, primaryId,
          opts.employeeId?.trim() || null, opts.phone?.trim() || null, opts.email?.trim() || null,
          t, t);
    nurseId = Number(r.lastInsertRowid);
    for (const id of stationIds) {
      await db.prepare("INSERT INTO nurse_stations (nurse_id, station_id, created_at) VALUES (?,?,?)")
        .run(nurseId, id, t);
    }
  });
  const stationLabel = stationIds.length
    ? stationIds.map(id => nameById.get(id)).join(", ")
    : "unassigned";
  await audit(opts.managerId, "nurse_create", stationLabel, { username, name: opts.name });
  return { ok: true, id: nurseId, username };
}

export async function editNurse(opts: {
  userId: number; name?: string; password?: string;
  stationIds?: number[]; managerId: number;
  employeeId?: string; phone?: string; email?: string;
}) {
  const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
    .get<{id: number; role: string}>(opts.userId);
  if (!user || user.role !== "NURSE") throw new HttpError(404, "Nurse user not found.");

  const t = now();
  await db.transaction(async () => {
    if (opts.name !== undefined)
      await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, t, opts.userId);
    if (opts.password)
      await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
        .run(bcrypt.hashSync(opts.password, 10), t, opts.userId);
    if (opts.stationIds !== undefined)
      await setNurseStations(opts.userId, opts.stationIds, t);
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

/** Add one station to a nurse's existing set, without disturbing the others
 *  (used when assigning an existing nurse to a station from that station's page). */
export async function addNurseStation(nurseId: number, stationId: number, managerId: number) {
  const user = await db.prepare("SELECT id, role, station_id FROM users WHERE id=?")
    .get<{id: number; role: string; station_id: number | null}>(nurseId);
  if (!user || user.role !== "NURSE") throw new HttpError(404, "Nurse user not found.");
  const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
    .get<{name: string}>(stationId);
  if (!ns) throw new HttpError(404, "Nursing station not found");

  const t = now();
  await db.prepare(
    "INSERT INTO nurse_stations (nurse_id, station_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING"
  ).run(nurseId, stationId, t);
  // First station ever assigned becomes the legacy "primary" column.
  if (user.station_id == null)
    await db.prepare("UPDATE users SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
      .run(stationId, ns.name, t, nurseId);
  await audit(managerId, "nurse_station_add", ns.name, { nurseId, stationId });
  return { ok: true };
}

/** Remove one station from a nurse's set, leaving any others untouched. */
export async function removeNurseStation(nurseId: number, stationId: number, managerId: number) {
  const user = await db.prepare("SELECT id, role, station_id FROM users WHERE id=?")
    .get<{id: number; role: string; station_id: number | null}>(nurseId);
  if (!user || user.role !== "NURSE") throw new HttpError(404, "Nurse user not found.");

  const t = now();
  await db.prepare("DELETE FROM nurse_stations WHERE nurse_id=? AND station_id=?").run(nurseId, stationId);
  if (user.station_id === stationId) {
    const next = await db.prepare(
      `SELECT ns2.station_id, ns.name FROM nurse_stations ns2
       JOIN nursing_stations ns ON ns.id = ns2.station_id
       WHERE ns2.nurse_id=? ORDER BY ns2.station_id LIMIT 1`
    ).get<{ station_id: number; name: string }>(nurseId);
    await db.prepare("UPDATE users SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
      .run(next?.station_id ?? null, next?.name ?? null, t, nurseId);
  }
  await audit(managerId, "nurse_station_remove", null, { nurseId, stationId });
  return { ok: true };
}

export async function deleteNurse(userId: number, managerId: number) {
  const user = await db.prepare("SELECT id, role, name FROM users WHERE id=?")
    .get<{id: number; role: string; name: string}>(userId);
  if (!user || user.role !== "NURSE") throw new HttpError(404, "Nurse user not found.");
  await db.prepare("DELETE FROM nurse_access_assignments WHERE nurse_id=?").run(userId);
  await db.prepare("DELETE FROM nurse_stations WHERE nurse_id=?").run(userId);
  await db.prepare("DELETE FROM users WHERE id=?").run(userId);
  await audit(managerId, "nurse_delete", null, { userId, name: user.name });
  return { ok: true };
}

// ── Doctor lifecycle ──────────────────────────────────────────────────────────
// Doctors are NOT tied to a block on the users row — block membership lives in
// doctor_block_users (many-to-many). Creating a doctor never requires a block.

export async function createDoctor(opts: {
  username: string; password: string; name: string;
  status?: "active" | "inactive"; remarks?: string; adminId: number;
}) {
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username))
    throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
  await guardUniqueUsername(username);

  const t = now();
  const status = opts.status ?? "active";
  const r = await db.prepare(
    `INSERT INTO users (username,password_hash,role,name,status,remarks,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`
  ).run(username, bcrypt.hashSync(opts.password, 10), "DOCTOR", opts.name.trim(),
        status, opts.remarks?.trim() || null, t, t);
  await audit(opts.adminId, "doctor_create", username, { name: opts.name, status });
  return { ok: true, id: Number(r.lastInsertRowid), username };
}

export async function editDoctor(opts: {
  userId: number; name?: string; password?: string;
  status?: "active" | "inactive"; remarks?: string | null; adminId: number;
}) {
  const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
    .get<{id: number; role: string}>(opts.userId);
  if (!user || user.role !== "DOCTOR") throw new HttpError(404, "Doctor user not found.");

  const t = now();
  await db.transaction(async () => {
    if (opts.name !== undefined)
      await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, t, opts.userId);
    if (opts.password)
      await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
        .run(bcrypt.hashSync(opts.password, 10), t, opts.userId);
    if (opts.status !== undefined)
      await db.prepare("UPDATE users SET status=?, updated_at=? WHERE id=?").run(opts.status, t, opts.userId);
    if (opts.remarks !== undefined)
      await db.prepare("UPDATE users SET remarks=?, updated_at=? WHERE id=?").run(opts.remarks?.trim() || null, t, opts.userId);
  });
  await audit(opts.adminId, "doctor_edit", null, { userId: opts.userId });
  return { ok: true };
}

export async function deleteDoctor(userId: number, adminId: number) {
  const user = await db.prepare("SELECT id, role, name FROM users WHERE id=?")
    .get<{id: number; role: string; name: string}>(userId);
  if (!user || user.role !== "DOCTOR") throw new HttpError(404, "Doctor user not found.");
  // doctor_block_users rows cascade away (membership only); blocks survive.
  await db.prepare("DELETE FROM users WHERE id=?").run(userId);
  await audit(adminId, "doctor_delete", null, { userId, name: user.name });
  return { ok: true };
}

// ── Nursing station lifecycle ─────────────────────────────────────────────────

export async function listNursingStations() {
  return db.prepare(
    `SELECT ns.id, ns.name,
            COUNT(DISTINCT w.id)::int   AS ward_count,
            COUNT(DISTINCT nst.nurse_id)::int AS nurse_count
     FROM nursing_stations ns
     LEFT JOIN wards w ON w.station_id = ns.id
     LEFT JOIN nurse_stations nst ON nst.station_id = ns.id
     GROUP BY ns.id, ns.name
     ORDER BY ns.name`
  ).all<{id: number; name: string; ward_count: number; nurse_count: number}>();
}

export async function createNursingStation(opts: { name: string; managerId: number }) {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Station name required");
  const t = now();
  try {
    const r = await db.prepare(
      "INSERT INTO nursing_stations (name, created_at, updated_at) VALUES (?,?,?) RETURNING id"
    ).run(name, t, t);
    await audit(opts.managerId, "station_create", name, {});
    return { ok: true, id: Number(r.lastInsertRowid), name };
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `Station "${name}" already exists`);
    throw err;
  }
}

export async function editNursingStation(opts: {
  stationId: number; name: string; managerId: number;
}) {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Station name required");
  const ex = await db.prepare("SELECT id FROM nursing_stations WHERE id=?").get<{id:number}>(opts.stationId);
  if (!ex) throw new HttpError(404, "Nursing station not found.");
  const t = now();
  try {
    await db.prepare("UPDATE nursing_stations SET name=?, updated_at=? WHERE id=?").run(name, t, opts.stationId);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, `Station name "${name}" already taken`);
    throw err;
  }
  await db.prepare("UPDATE wards SET nursing_station=? WHERE station_id=?").run(name, opts.stationId);
  await db.prepare("UPDATE users SET nursing_station=? WHERE station_id=?").run(name, opts.stationId);
  await audit(opts.managerId, "station_edit", name, { stationId: opts.stationId });
  return { ok: true };
}

export async function assignWardsToStation(stationId: number, wardIds: number[], managerId: number) {
  const s = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
    .get<{id: number; name: string}>(stationId);
  if (!s) throw new HttpError(404, "Nursing station not found.");
  const t = now();

  const currentWards = await db.prepare("SELECT id FROM wards WHERE station_id=?")
    .all<{ id: number }>(stationId);
  const currentWardIdSet = new Set(currentWards.map(w => w.id));
  const newWardIdSet     = new Set(wardIds);

  // Wards removed from this station → delete this station's nurses' access to them
  for (const { id: wardId } of currentWards) {
    if (!newWardIdSet.has(wardId)) {
      await db.prepare(
        `DELETE FROM nurse_access_assignments
         WHERE ward_id=? AND nurse_id IN (SELECT nurse_id FROM nurse_stations WHERE station_id=?)`
      ).run(wardId, stationId);
    }
  }

  // Wards moved in from a different station → delete old station's nurses' access
  for (const wardId of wardIds) {
    if (!currentWardIdSet.has(wardId)) {
      const ward = await db.prepare("SELECT station_id FROM wards WHERE id=?")
        .get<{ station_id: number | null }>(wardId);
      if (ward?.station_id && ward.station_id !== stationId) {
        await db.prepare(
          `DELETE FROM nurse_access_assignments
           WHERE ward_id=? AND nurse_id IN (SELECT nurse_id FROM nurse_stations WHERE station_id=?)`
        ).run(wardId, ward.station_id);
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

export async function deleteNursingStation(stationId: number, managerId: number) {
  const s = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
    .get<{id: number; name: string}>(stationId);
  if (!s) throw new HttpError(404, "Nursing station not found.");

  // Refuse while wards or nurses are still attached — deleting would otherwise
  // silently null out their station and drop the wards' nurse-access rows.
  // Check BOTH up front so the manager sees every reason at once, not just
  // whichever one happens to be checked first.
  const blockers: string[] = [];

  const wards = await db.prepare(
    "SELECT name FROM wards WHERE station_id=? ORDER BY name"
  ).all<{ name: string }>(stationId);
  if (wards.length)
    blockers.push(`${wards.length} ward${wards.length > 1 ? "s" : ""} (${quoteList(wards.map(w => w.name))})`);

  const nurses = await db.prepare(
    `SELECT DISTINCT u.name FROM nurse_stations nst
     JOIN users u ON u.id = nst.nurse_id
     WHERE nst.station_id=? ORDER BY u.name`
  ).all<{ name: string }>(stationId);
  if (nurses.length)
    blockers.push(`${nurses.length} nurse${nurses.length > 1 ? "s" : ""} (${quoteList(nurses.map(n => n.name))})`);

  if (blockers.length)
    throw new HttpError(409,
      `Station "${s.name}" still has ${joinClauses(blockers)}. Reassign them before deleting this station.`);

  await db.prepare("DELETE FROM nursing_stations WHERE id=?").run(stationId);
  await audit(managerId, "station_delete", s.name, { stationId });
  return { ok: true };
}

// ── history ───────────────────────────────────────────────────────────────────

export async function availableDates(): Promise<string[]> {
  // Postgres rejects DISTINCT + ORDER BY on a non-selected column; round_key
  // dates are YYYY-MM-DD so sorting them directly gives newest-first.
  // round_key format is "block|date|startMin" (no shift segment).
  const [roundRows, censusRows] = await Promise.all([
    db.prepare(
      "SELECT DISTINCT SPLIT_PART(round_key, '|', 2) AS date FROM pre_rounds WHERE round_key LIKE '%|%|%'"
    ).all<{ date: string }>(),
    db.prepare("SELECT census_date FROM midnight_census").all<{ census_date: string }>(),
  ]);
  const dates = new Set<string>([
    ...roundRows.map(r => r.date).filter(Boolean),
    ...censusRows.map(c => c.census_date),
  ]);
  return [...dates].sort().reverse();
}

export async function censusDates(): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT census_date FROM midnight_census ORDER BY census_date DESC"
  ).all<{ census_date: string }>();
  return rows.map(r => r.census_date);
}

// Rounds are submitted per PRE Block (pre_rounds.pre_block_id); floor_id is a
// legacy column that is NULL on all new rows.
export async function historyForDate(date: string, preBlockId?: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Invalid date format. Use YYYY-MM-DD.");
  let sql =
    `SELECT pr.pre_block_id, pb.name AS block_name,
            pr.start_min AS "startMin", pr.submitted_at AS "submittedAt", pr.snapshot
     FROM pre_rounds pr
     LEFT JOIN pre_blocks pb ON pb.id = pr.pre_block_id
     WHERE pr.round_key LIKE ?`;
  const params: unknown[] = [`%|${date}|%`];
  if (preBlockId !== undefined) { sql += " AND pr.pre_block_id=?"; params.push(preBlockId); }
  sql += " ORDER BY pr.submitted_at";

  const rows = await db.prepare(sql).all<{
    pre_block_id: number; block_name: string | null;
    startMin: number; submittedAt: number; snapshot: string;
  }>(...params);

  return rows.map(r => ({
    preBlockId: r.pre_block_id,
    floorId:    r.pre_block_id,                       // legacy alias for older clients
    floorCode:  r.block_name || `PB${r.pre_block_id}`,
    blockName:  r.block_name,
    floorName:  r.block_name || `PRE Block ${r.pre_block_id}`,
    submittedAt: r.submittedAt,
    startMin:   r.startMin,
    wards: (() => { try { return JSON.parse(r.snapshot || "[]"); } catch { return []; } })(),
  }));
}

// ── Nurse Access Assignments ──────────────────────────────────────────────────

interface NaaRow {
  id: number; nurse_id: number; ward_id: number;
  access_type: string; bed_names: string; status: string;
  created_at: number; updated_at: number; created_by: number | null;
  nurse_name: string; nurse_username: string; ward_name: string;
  ward_station_id: number | null; ward_operational: boolean;
}

function parseNaa(r: NaaRow) {
  let beds: string[] = [];
  try { beds = JSON.parse(r.bed_names || "[]"); } catch { /* corrupt */ }
  return { ...r, bed_names: beds };
}

export async function listNurseAccess(filters: {
  nurseId?: number; wardId?: number; status?: string;
} = {}) {
  let sql = `
    SELECT naa.id, naa.nurse_id, naa.ward_id, naa.access_type, naa.bed_names,
           naa.status, naa.created_at, naa.updated_at, naa.created_by,
           u.name AS nurse_name, u.username AS nurse_username, w.name AS ward_name,
           w.station_id AS ward_station_id, w.operational AS ward_operational
    FROM nurse_access_assignments naa
    JOIN users u ON u.id = naa.nurse_id
    JOIN wards w ON w.id = naa.ward_id
    WHERE 1=1`;
  const params: unknown[] = [];
  if (filters.nurseId !== undefined) { sql += " AND naa.nurse_id=?"; params.push(filters.nurseId); }
  if (filters.wardId  !== undefined) { sql += " AND naa.ward_id=?";  params.push(filters.wardId); }
  if (filters.status)                { sql += " AND naa.status=?";   params.push(filters.status); }
  sql += " ORDER BY u.name, w.name";
  const rows = await db.prepare(sql).all<NaaRow>(...params);
  return rows.map(parseNaa);
}

export async function createNurseAccess(opts: {
  nurseId: number; wardId: number; accessType: "FULL" | "BEDS";
  bedNames?: string[]; managerId: number;
}) {
  const { nurseId, wardId, accessType, managerId } = opts;
  const bedNames = [...new Set(opts.bedNames ?? [])];
  if (accessType === "BEDS" && bedNames.length === 0)
    throw new HttpError(400, "Select at least one bed for Selected Beds access");

  const existing = await db.prepare(
    "SELECT id, access_type FROM nurse_access_assignments WHERE nurse_id=? AND ward_id=?"
  ).get<{ id: number; access_type: string }>(nurseId, wardId);

  if (existing) {
    if (existing.access_type === "FULL")
      throw new HttpError(409, "This nurse already has Full Access to this ward");
    // existing is BEDS; upgrade to FULL or update beds
  }

  const t = now();
  const bedJson = JSON.stringify(accessType === "FULL" ? [] : bedNames);

  if (existing) {
    await db.prepare(
      "UPDATE nurse_access_assignments SET access_type=?, bed_names=?, updated_at=?, created_by=? WHERE id=?"
    ).run(accessType, bedJson, t, managerId, existing.id);
    await audit(managerId, "nurse_access_update", null, { id: existing.id, nurseId, wardId, accessType });
    return { ok: true, id: existing.id };
  }

  const r = await db.prepare(
    `INSERT INTO nurse_access_assignments
       (nurse_id, ward_id, access_type, bed_names, status, created_at, updated_at, created_by)
     VALUES (?,?,?,?,'active',?,?,?) RETURNING id`
  ).run(nurseId, wardId, accessType, bedJson, t, t, managerId);
  const id = Number(r.lastInsertRowid);
  await audit(managerId, "nurse_access_create", null, { id, nurseId, wardId, accessType });
  return { ok: true, id };
}

export async function editNurseAccess(opts: {
  id: number; accessType?: "FULL" | "BEDS";
  bedNames?: string[]; status?: "active" | "inactive"; managerId: number;
}) {
  const row = await db.prepare(
    "SELECT id, access_type, bed_names, status FROM nurse_access_assignments WHERE id=?"
  ).get<{ id: number; access_type: string; bed_names: string; status: string }>(opts.id);
  if (!row) throw new HttpError(404, "Nurse access assignment not found.");

  const accessType = (opts.accessType ?? row.access_type) as "FULL" | "BEDS";
  let beds: string[];
  if (opts.bedNames !== undefined) {
    beds = [...new Set(opts.bedNames)];
  } else {
    try { beds = JSON.parse(row.bed_names || "[]"); } catch { beds = []; }
  }
  if (accessType === "BEDS" && beds.length === 0)
    throw new HttpError(400, "Select at least one bed for Selected Beds access");

  const status = opts.status ?? row.status;
  const bedJson = JSON.stringify(accessType === "FULL" ? [] : beds);
  await db.prepare(
    "UPDATE nurse_access_assignments SET access_type=?, bed_names=?, status=?, updated_at=? WHERE id=?"
  ).run(accessType, bedJson, status, now(), opts.id);
  await audit(opts.managerId, "nurse_access_edit", null, { id: opts.id, accessType, status });
  return { ok: true };
}

export async function deleteNurseAccess(id: number, managerId: number) {
  const row = await db.prepare(
    "SELECT id, nurse_id, ward_id FROM nurse_access_assignments WHERE id=?"
  ).get<{ id: number; nurse_id: number; ward_id: number }>(id);
  if (!row) throw new HttpError(404, "Nurse access assignment not found.");
  await db.prepare("DELETE FROM nurse_access_assignments WHERE id=?").run(id);
  await audit(managerId, "nurse_access_delete", null, { id, nurseId: row.nurse_id, wardId: row.ward_id });
  return { ok: true };
}

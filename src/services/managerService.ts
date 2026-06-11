import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

const now = () => Date.now();

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
  try {
    const r = await db.prepare(
      "INSERT INTO building_blocks (name, label, sort_order, created_at, updated_at) VALUES (?,?,?,?,?) RETURNING id"
    ).run(name, opts.label?.trim() || `Block ${name}`,
          (await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM building_blocks").get<{n:number}>())!.n,
          t, t);
    await audit(opts.managerId, "building_block_create", name, {});
    return { ok: true, id: Number(r.lastInsertRowid), name };
  } catch {
    throw new HttpError(409, `Block "${name}" already exists`);
  }
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
    await db.prepare("UPDATE building_blocks SET name=?, updated_at=? WHERE id=?").run(n, t, opts.blockId);
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
            (SELECT name FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_name,
            (SELECT shift FROM users u WHERE u.floor_id = f.id AND u.role = 'PRE' LIMIT 1) AS pre_user_shift
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
  const sortRow = await db.prepare(
    "SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM floors WHERE building_block_id=?"
  ).get<{ n: number }>(opts.buildingBlockId);

  try {
    const r = await db.prepare(
      "INSERT INTO floors (name, code, block_label, building_block_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id"
    ).run(name, name.replace(/\s+/g, "").substring(0, 20).toUpperCase(),
          bb.name, opts.buildingBlockId, sortRow!.n, t, t);
    await audit(opts.managerId, "floor_create", `${bb.name}-${name}`, {});
    return { ok: true, id: Number(r.lastInsertRowid), name };
  } catch {
    throw new HttpError(409, `A floor named "${name}" already exists in Block ${bb.name}`);
  }
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
  await db.prepare("UPDATE floors SET name=?, code=?, updated_at=? WHERE id=?")
    .run(name, name.replace(/\s+/g, "").substring(0, 20).toUpperCase(), t, opts.floorId);
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
      await db.prepare("INSERT INTO beds (ward_id, total) VALUES (?,?)").run(wardId, total);
      if (total > 0) {
        const ins = db.prepare(
          "INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, updated_at, updated_by) VALUES (?,?,'VACANT','NONE',?,?,?,?)"
        );
        for (let i = 1; i <= total; i++) await ins.run(wardId, String(i), bedType, operational, t, opts.managerId);
      }
    });
    await audit(opts.managerId, "ward_create", floor.name, { name: opts.name, totalBeds: total, bedType, operational });
    return { ok: true, id: wardId };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, `Ward "${opts.name}" already exists on this floor`);
  }
}

export async function editWard(opts: {
  wardId: number; name?: string; totalBeds?: number; floorId?: number; managerId: number;
  stationId?: number | null; unitType?: string | null; roomType?: string | null;
  bedType?: string | null; operational?: boolean | null;
}) {
  const ward = await db.prepare("SELECT id, floor_id FROM wards WHERE id=?")
    .get<{ id: number; floor_id: number }>(opts.wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  const t = now();

  await db.transaction(async () => {
    if (opts.name !== undefined)
      await db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?")
        .run(opts.name.trim(), t, opts.wardId);
    if (opts.totalBeds !== undefined) {
      const actual = (await db.prepare("SELECT COUNT(*) AS c FROM bed_details WHERE ward_id=?")
        .get<{c:number}>(opts.wardId))?.c ?? 0;
      if (opts.totalBeds !== actual)
        throw new HttpError(409, `Capacity is derived from beds (currently ${actual}). Add or delete beds to change it.`);
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
    ? (await db.prepare("SELECT name FROM floors WHERE id=?").get<{name:string}>(ward.floor_id))?.name
    : "unknown";
  await audit(opts.managerId, "ward_edit", floorName ?? "unknown", { wardId: opts.wardId });
  return { ok: true };
}

export async function deleteWard(wardId: number, managerId: number) {
  const ward = await db.prepare("SELECT floor_id FROM wards WHERE id=?")
    .get<{ floor_id: number }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  await db.prepare("DELETE FROM wards WHERE id=?").run(wardId);
  await audit(managerId, "ward_delete", "floor", { wardId });
  return { ok: true };
}

// ── PRE user lifecycle ────────────────────────────────────────────────────────

export async function createPre(opts: {
  username: string; password: string; name: string;
  preBlockId?: number | null; shift?: "morning" | "night"; managerId: number;
}) {
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username))
    throw new HttpError(400, "Username: letters, numbers, underscore only");
  if (await db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
    throw new HttpError(409, "Username already taken");

  if (opts.preBlockId != null) {
    const pb = await db.prepare("SELECT name FROM pre_blocks WHERE id=?")
      .get<{name:string}>(opts.preBlockId);
    if (!pb) throw new HttpError(404, "PRE Block not found");
  }

  const t = now();
  const shift = opts.shift || "morning";
  const r = await db.prepare(
    "INSERT INTO users (username,password_hash,role,name,shift,pre_block_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id"
  ).run(username, bcrypt.hashSync(opts.password, 10), "PRE", opts.name, shift,
        opts.preBlockId ?? null, t, t);

  const blockName = opts.preBlockId
    ? (await db.prepare("SELECT name FROM pre_blocks WHERE id=?").get<{name:string}>(opts.preBlockId))?.name
    : null;
  await audit(opts.managerId, "pre_create", blockName ?? "unassigned", { username, name: opts.name, shift });
  return { ok: true, id: Number(r.lastInsertRowid), username };
}

export async function editPre(opts: {
  userId: number; name?: string; password?: string;
  shift?: "morning" | "night"; preBlockId?: number | null; managerId: number;
}) {
  const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
    .get<{id: number; role: string}>(opts.userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE not found");

  if (opts.preBlockId != null) {
    const pb = await db.prepare("SELECT id FROM pre_blocks WHERE id=?").get<{id:number}>(opts.preBlockId);
    if (!pb) throw new HttpError(404, "PRE Block not found");
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

export async function setPreShift(userId: number, shift: "morning" | "night", managerId: number) {
  const user = await db.prepare("SELECT id,role FROM users WHERE id=?")
    .get<{id: number; role: string}>(userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE not found");
  await db.prepare("UPDATE users SET shift=?,updated_at=? WHERE id=?").run(shift, now(), userId);
  await audit(managerId, "pre_shift", null, { userId, shift });
  return { ok: true, shift };
}

export async function deletePre(userId: number, managerId: number) {
  const user = await db.prepare("SELECT id,role,name,floor_id FROM users WHERE id=?")
    .get<{id: number; role: string; name: string; floor_id: number | null}>(userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE not found");
  await db.prepare("DELETE FROM users WHERE id=?").run(userId);
  await audit(managerId, "pre_delete", null, { userId, name: user.name });
  return { ok: true };
}

// ── Nurse In-Charge lifecycle ─────────────────────────────────────────────────

export async function createNurse(opts: {
  username: string; password: string; name: string;
  stationId: number; managerId: number;
}) {
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username))
    throw new HttpError(400, "Username: letters, numbers, underscore only");
  if (await db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
    throw new HttpError(409, "Username already taken");

  const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
    .get<{name: string}>(opts.stationId);
  if (!ns) throw new HttpError(404, "Nursing station not found");

  const t = now();
  const r = await db.prepare(
    "INSERT INTO users (username,password_hash,role,name,shift,nursing_station,station_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id"
  ).run(username, bcrypt.hashSync(opts.password, 10), "NURSE", opts.name.trim(),
        "morning", ns.name, opts.stationId, t, t);
  await audit(opts.managerId, "nurse_create", ns.name, { username, name: opts.name });
  return { ok: true, id: Number(r.lastInsertRowid), username };
}

export async function editNurse(opts: {
  userId: number; name?: string; password?: string;
  stationId?: number; managerId: number;
}) {
  const user = await db.prepare("SELECT id, role FROM users WHERE id=?")
    .get<{id: number; role: string}>(opts.userId);
  if (!user || user.role !== "NURSE") throw new HttpError(404, "Nurse not found");

  const t = now();
  await db.transaction(async () => {
    if (opts.name !== undefined)
      await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, t, opts.userId);
    if (opts.password)
      await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
        .run(bcrypt.hashSync(opts.password, 10), t, opts.userId);
    if (opts.stationId !== undefined) {
      const ns = await db.prepare("SELECT name FROM nursing_stations WHERE id=?")
        .get<{name: string}>(opts.stationId);
      if (!ns) throw new HttpError(404, "Nursing station not found");
      await db.prepare("UPDATE users SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
        .run(opts.stationId, ns.name, t, opts.userId);
    }
  });
  await audit(opts.managerId, "nurse_edit", null, { userId: opts.userId });
  return { ok: true };
}

export async function deleteNurse(userId: number, managerId: number) {
  const user = await db.prepare("SELECT id, role, name FROM users WHERE id=?")
    .get<{id: number; role: string; name: string}>(userId);
  if (!user || user.role !== "NURSE") throw new HttpError(404, "Nurse not found");
  await db.prepare("DELETE FROM users WHERE id=?").run(userId);
  await audit(managerId, "nurse_delete", null, { userId, name: user.name });
  return { ok: true };
}

// ── Nursing station lifecycle ─────────────────────────────────────────────────

export async function listNursingStations() {
  return db.prepare(
    `SELECT ns.id, ns.name,
            COUNT(DISTINCT w.id)::int  AS ward_count,
            COUNT(DISTINCT u.id)::int  AS nurse_count
     FROM nursing_stations ns
     LEFT JOIN wards w ON w.station_id = ns.id
     LEFT JOIN users u ON u.station_id = ns.id AND u.role = 'NURSE'
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
  } catch {
    throw new HttpError(409, `Station "${name}" already exists`);
  }
}

export async function editNursingStation(opts: {
  stationId: number; name: string; managerId: number;
}) {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Station name required");
  const ex = await db.prepare("SELECT id FROM nursing_stations WHERE id=?").get<{id:number}>(opts.stationId);
  if (!ex) throw new HttpError(404, "Station not found");
  const t = now();
  try {
    await db.prepare("UPDATE nursing_stations SET name=?, updated_at=? WHERE id=?").run(name, t, opts.stationId);
    await db.prepare("UPDATE wards SET nursing_station=? WHERE station_id=?").run(name, opts.stationId);
    await db.prepare("UPDATE users SET nursing_station=? WHERE station_id=?").run(name, opts.stationId);
    await audit(opts.managerId, "station_edit", name, { stationId: opts.stationId });
    return { ok: true };
  } catch {
    throw new HttpError(409, `Station name "${name}" already taken`);
  }
}

export async function assignWardsToStation(stationId: number, wardIds: number[], managerId: number) {
  const s = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
    .get<{id: number; name: string}>(stationId);
  if (!s) throw new HttpError(404, "Station not found");
  const t = now();
  // Clear all wards currently assigned to this station
  await db.prepare("UPDATE wards SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE station_id=?")
    .run(t, stationId);
  // Assign the selected wards (may move them away from another station)
  for (const wardId of wardIds) {
    await db.prepare("UPDATE wards SET station_id=?, nursing_station=?, updated_at=? WHERE id=?")
      .run(stationId, s.name, t, wardId);
  }
  await audit(managerId, "station_assign_wards", s.name, { stationId, wardIds });
  return { ok: true };
}

export async function deleteNursingStation(stationId: number, managerId: number) {
  const s = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
    .get<{id: number; name: string}>(stationId);
  if (!s) throw new HttpError(404, "Station not found");
  const t = now();
  // Unassign all wards and nurses before deleting
  await db.prepare("UPDATE wards SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE station_id=?").run(t, stationId);
  await db.prepare("UPDATE users SET station_id=NULL, nursing_station=NULL, updated_at=? WHERE station_id=?").run(t, stationId);
  await db.prepare("DELETE FROM nursing_stations WHERE id=?").run(stationId);
  await audit(managerId, "station_delete", s.name, { stationId });
  return { ok: true };
}

// ── history ───────────────────────────────────────────────────────────────────

export async function availableDates(): Promise<string[]> {
  const rows = await db.prepare(
    "SELECT DISTINCT round_key FROM pre_rounds ORDER BY submitted_at DESC"
  ).all<{round_key: string}>();
  const dates = new Set<string>();
  for (const r of rows) {
    const parts = r.round_key.split("|");
    if (parts[2]) dates.add(parts[2]);
  }
  return [...dates];
}

export async function historyForDate(date: string, floorId?: number) {
  let sql =
    `SELECT pr.floor_id, f.name AS floor_name, bb.name AS block_name,
            pr.shift, pr.start_min AS startMin, pr.submitted_at AS submittedAt, pr.snapshot
     FROM pre_rounds pr
     LEFT JOIN floors f ON f.id = pr.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     WHERE pr.round_key LIKE ?`;
  const params: unknown[] = [`%|${date}|%`];
  if (floorId !== undefined) { sql += " AND pr.floor_id=?"; params.push(floorId); }
  sql += " ORDER BY pr.submitted_at";

  const rows = await db.prepare(sql).all<{
    floor_id: number; floor_name: string; block_name: string;
    shift: string; startMin: number; submittedAt: number; snapshot: string;
  }>(...params);

  return rows.map(r => ({
    floorId:   r.floor_id,
    floorCode: r.floor_name,
    blockName: r.block_name,
    floorName: r.block_name ? `${r.block_name} - ${r.floor_name}` : r.floor_name,
    shift:     r.shift,
    startMin:  r.startMin,
    submittedAt: r.submittedAt,
    wards: (() => { try { return JSON.parse(r.snapshot || "[]"); } catch { return []; } })(),
  }));
}

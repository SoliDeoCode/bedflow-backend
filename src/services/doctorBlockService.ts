import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

const now = () => Date.now();

// ── Types ─────────────────────────────────────────────────────────────────────

interface DoctorBlockRow {
  id: number; name: string; description: string | null; status: string;
  created_by: number | null; created_at: number; updated_at: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// A ward may belong to only ONE Doctor Block. Validate the requested wards are
// free (or already in THIS block) and report the clash by name, not id.
async function assertWardsAssignable(wardIds: number[], selfBlockId: number | null) {
  for (const wardId of wardIds) {
    const ward = await db.prepare("SELECT id, name, operational, total_beds FROM wards WHERE id=?")
      .get<{ id: number; name: string; operational: boolean; total_beds: number }>(wardId);
    if (!ward) throw new HttpError(404, `Ward ${wardId} not found`);
    if (!ward.operational)
      throw new HttpError(400, `Ward "${ward.name}" is non-operational. Reactivate it before adding it to a Doctor Block.`);

    const clash = await db.prepare(
      `SELECT db.name FROM doctor_block_wards dbw
       JOIN doctor_blocks db ON db.id = dbw.doctor_block_id
       WHERE dbw.ward_id = ? AND dbw.doctor_block_id <> ?`
    ).get<{ name: string }>(wardId, selfBlockId ?? -1);
    if (clash)
      throw new HttpError(409, `Ward "${ward.name}" is already assigned to Doctor Block "${clash.name}". A ward can belong to only one Doctor Block.`);
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function listDoctorBlocks() {
  return db.prepare(`
    SELECT db.id, db.name, db.description, db.status, db.created_at, db.updated_at,
           COUNT(DISTINCT dbw.ward_id)::int AS ward_count,
           COUNT(DISTINCT dbu.user_id)::int AS doctor_count,
           COALESCE(wb.total_beds, 0)       AS total_beds
    FROM doctor_blocks db
    LEFT JOIN doctor_block_wards dbw ON dbw.doctor_block_id = db.id
    LEFT JOIN doctor_block_users dbu ON dbu.doctor_block_id = db.id
    LEFT JOIN LATERAL (
      SELECT SUM(w.total_beds)::int AS total_beds
      FROM doctor_block_wards dbw2
      JOIN wards w ON w.id = dbw2.ward_id
      WHERE dbw2.doctor_block_id = db.id
    ) wb ON true
    GROUP BY db.id, wb.total_beds
    ORDER BY db.status DESC, db.name
  `).all<DoctorBlockRow & { ward_count: number; doctor_count: number; total_beds: number }>();
}

export async function getDoctorBlock(id: number) {
  const block = await db.prepare("SELECT * FROM doctor_blocks WHERE id=?")
    .get<DoctorBlockRow>(id);
  if (!block) throw new HttpError(404, "Doctor Block not found");

  const wards = await db.prepare(`
    SELECT w.id, w.name, w.total_beds, w.unit_type, w.bed_type, w.operational,
           f.name  AS floor_name,
           bb.name AS block_name,
           dbw.created_at AS assigned_at
    FROM doctor_block_wards dbw
    JOIN wards w ON w.id = dbw.ward_id
    LEFT JOIN floors f           ON f.id  = w.floor_id
    LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
    WHERE dbw.doctor_block_id = ?
    ORDER BY bb.name, f.name, w.name
  `).all(id);

  const doctors = await db.prepare(`
    SELECT u.id, u.username, u.name, u.status, dbu.created_at AS assigned_at
    FROM doctor_block_users dbu
    JOIN users u ON u.id = dbu.user_id
    WHERE dbu.doctor_block_id = ?
    ORDER BY u.name
  `).all(id);

  return { ...block, wards, doctors };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createDoctorBlock(opts: {
  name: string; description?: string; wardIds?: number[]; doctorIds?: number[]; adminId: number;
}) {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Doctor Block name is required");

  const clash = await db.prepare("SELECT id FROM doctor_blocks WHERE LOWER(name)=LOWER(?)").get(name);
  if (clash) throw new HttpError(409, `Doctor Block "${name}" already exists`);

  const wardIds   = opts.wardIds ?? [];
  const doctorIds = opts.doctorIds ?? [];
  await assertWardsAssignable(wardIds, null);
  await assertDoctors(doctorIds);

  const t = now();
  let blockId = 0;
  await db.transaction(async () => {
    const r = await db.prepare(
      `INSERT INTO doctor_blocks (name, description, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?) RETURNING id`
    ).run(name, opts.description?.trim() || null, "active", opts.adminId, t, t);
    blockId = Number(r.lastInsertRowid);
    for (const wardId of wardIds)
      await db.prepare("INSERT INTO doctor_block_wards (doctor_block_id, ward_id, created_at) VALUES (?,?,?)").run(blockId, wardId, t);
    for (const userId of doctorIds)
      await db.prepare("INSERT INTO doctor_block_users (doctor_block_id, user_id, created_at, created_by) VALUES (?,?,?,?)").run(blockId, userId, t, opts.adminId);
  });

  await audit(opts.adminId, "doctor_block_create", name, { wardCount: wardIds.length, doctorCount: doctorIds.length });
  return { ok: true, id: blockId };
}

async function assertDoctors(doctorIds: number[]) {
  for (const id of doctorIds) {
    const u = await db.prepare("SELECT id, role FROM users WHERE id=?").get<{ id: number; role: string }>(id);
    if (!u || u.role !== "DOCTOR") throw new HttpError(404, `Doctor ${id} not found`);
  }
}

export async function editDoctorBlock(opts: {
  blockId: number; name?: string; description?: string | null;
  wardIds?: number[]; doctorIds?: number[]; adminId: number;
}) {
  const block = await db.prepare("SELECT id, name FROM doctor_blocks WHERE id=?")
    .get<{ id: number; name: string }>(opts.blockId);
  if (!block) throw new HttpError(404, "Doctor Block not found");

  if (opts.wardIds !== undefined) await assertWardsAssignable(opts.wardIds, opts.blockId);
  if (opts.doctorIds !== undefined) await assertDoctors(opts.doctorIds);

  const t = now();
  await db.transaction(async () => {
    if (opts.name !== undefined) {
      const clash = await db.prepare("SELECT id FROM doctor_blocks WHERE LOWER(name)=LOWER(?) AND id<>?")
        .get(opts.name.trim(), opts.blockId);
      if (clash) throw new HttpError(409, `Doctor Block "${opts.name}" already exists`);
      await db.prepare("UPDATE doctor_blocks SET name=?, updated_at=? WHERE id=?").run(opts.name.trim(), t, opts.blockId);
    }
    if (opts.description !== undefined)
      await db.prepare("UPDATE doctor_blocks SET description=?, updated_at=? WHERE id=?").run(opts.description?.trim() || null, t, opts.blockId);

    if (opts.wardIds !== undefined) {
      await db.prepare("DELETE FROM doctor_block_wards WHERE doctor_block_id=?").run(opts.blockId);
      for (const wardId of opts.wardIds)
        await db.prepare("INSERT INTO doctor_block_wards (doctor_block_id, ward_id, created_at) VALUES (?,?,?)").run(opts.blockId, wardId, t);
      await db.prepare("UPDATE doctor_blocks SET updated_at=? WHERE id=?").run(t, opts.blockId);
    }
    if (opts.doctorIds !== undefined) {
      await db.prepare("DELETE FROM doctor_block_users WHERE doctor_block_id=?").run(opts.blockId);
      for (const userId of opts.doctorIds)
        await db.prepare("INSERT INTO doctor_block_users (doctor_block_id, user_id, created_at, created_by) VALUES (?,?,?,?)").run(opts.blockId, userId, t, opts.adminId);
      await db.prepare("UPDATE doctor_blocks SET updated_at=? WHERE id=?").run(t, opts.blockId);
    }
  });

  await audit(opts.adminId, "doctor_block_edit", block.name, {});
  return { ok: true };
}

export async function setDoctorBlockStatus(blockId: number, status: "active" | "inactive", adminId: number) {
  const block = await db.prepare("SELECT name FROM doctor_blocks WHERE id=?").get<{ name: string }>(blockId);
  if (!block) throw new HttpError(404, "Doctor Block not found");
  await db.prepare("UPDATE doctor_blocks SET status=?, updated_at=? WHERE id=?").run(status, now(), blockId);
  await audit(adminId, `doctor_block_${status}`, block.name, {});
  return { ok: true };
}

export async function deleteDoctorBlock(blockId: number, adminId: number) {
  const block = await db.prepare("SELECT name FROM doctor_blocks WHERE id=?").get<{ name: string }>(blockId);
  if (!block) throw new HttpError(404, "Doctor Block not found");
  // doctor_block_wards / doctor_block_users cascade away with the block. The
  // doctors and wards themselves are untouched (membership is many-to-many, so
  // no doctor is orphaned the way a PRE user would be).
  await db.prepare("DELETE FROM doctor_blocks WHERE id=?").run(blockId);
  await audit(adminId, "doctor_block_delete", block.name, {});
  return { ok: true };
}

/** Affected ward ids for a block — used to target socket ward rooms on mutations. */
export async function wardIdsForDoctorBlock(blockId: number): Promise<number[]> {
  const rows = await db.prepare("SELECT ward_id FROM doctor_block_wards WHERE doctor_block_id=?")
    .all<{ ward_id: number }>(blockId);
  return rows.map((r) => Number(r.ward_id));
}

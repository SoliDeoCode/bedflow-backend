import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

const now = () => Date.now();

// ── Types ─────────────────────────────────────────────────────────────────────

interface PreBlockRow {
  id: number; name: string; description: string | null; status: string;
  created_by: number | null; created_at: number; updated_at: number;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function listPreBlocks() {
  return db.prepare(`
    SELECT pb.id, pb.name, pb.description, pb.status,
           pb.created_at, pb.updated_at,
           COUNT(pbw.ward_id)::int       AS ward_count,
           COALESCE(SUM(w.total_beds)::int, 0) AS total_beds
    FROM pre_blocks pb
    LEFT JOIN pre_block_wards pbw ON pbw.pre_block_id = pb.id
    LEFT JOIN wards w ON w.id = pbw.ward_id
    GROUP BY pb.id
    ORDER BY pb.status DESC, pb.name
  `).all<PreBlockRow & { ward_count: number; total_beds: number }>();
}

export async function getPreBlock(id: number) {
  const block = await db.prepare("SELECT * FROM pre_blocks WHERE id=?")
    .get<PreBlockRow>(id);
  if (!block) throw new HttpError(404, "PRE Block not found");

  const wards = await db.prepare(`
    SELECT w.id, w.name, w.total_beds, w.unit_type, w.bed_type, w.operational,
           f.name  AS floor_name,
           bb.name AS block_name,
           ns.name AS station_name,
           pbw.created_at AS assigned_at
    FROM pre_block_wards pbw
    JOIN wards w ON w.id = pbw.ward_id
    LEFT JOIN floors f            ON f.id  = w.floor_id
    LEFT JOIN building_blocks bb  ON bb.id = f.building_block_id
    LEFT JOIN nursing_stations ns ON ns.id = w.station_id
    WHERE pbw.pre_block_id = ?
    ORDER BY bb.name, f.name, w.name
  `).all(id);

  return { ...block, wards };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createPreBlock(opts: {
  name: string; description?: string; wardIds: number[]; managerId: number;
}) {
  if (opts.wardIds.length === 0)
    throw new HttpError(400, "A PRE Block must contain at least one ward");

  const clash = await db.prepare("SELECT id FROM pre_blocks WHERE LOWER(name)=LOWER(?)")
    .get(opts.name.trim());
  if (clash) throw new HttpError(409, `PRE Block "${opts.name}" already exists`);

  const t = now();
  let blockId = 0;
  await db.transaction(async () => {
    const r = await db.prepare(
      `INSERT INTO pre_blocks (name, description, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?) RETURNING id`
    ).run(opts.name.trim(), opts.description?.trim() || null, "active", opts.managerId, t, t);
    blockId = Number(r.lastInsertRowid);

    for (const wardId of opts.wardIds) {
      const ward = await db.prepare("SELECT id, name, operational, total_beds FROM wards WHERE id=?")
        .get<{ id: number; name: string; operational: boolean; total_beds: number }>(wardId);
      if (!ward) throw new HttpError(404, `Ward ${wardId} not found`);
      if (!ward.operational)
        throw new HttpError(400, `Ward "${ward.name}" is non-operational. Reactivate it before adding it to a PRE block.`);
      if (ward.total_beds === 0)
        throw new HttpError(400, `Ward "${ward.name}" has no beds. Add beds to this ward before assigning it to a PRE block.`);
      await db.prepare(
        "INSERT INTO pre_block_wards (pre_block_id, ward_id, created_at) VALUES (?,?,?)"
      ).run(blockId, wardId, t);
    }
  });

  await audit(opts.managerId, "pre_block_create", opts.name, { wardCount: opts.wardIds.length });
  return { ok: true, id: blockId };
}

export async function editPreBlock(opts: {
  blockId: number; name?: string; description?: string | null;
  wardIds?: number[]; managerId: number;
}) {
  const block = await db.prepare("SELECT id, name FROM pre_blocks WHERE id=?")
    .get<{ id: number; name: string }>(opts.blockId);
  if (!block) throw new HttpError(404, "PRE Block not found");

  if (opts.wardIds !== undefined && opts.wardIds.length === 0)
    throw new HttpError(400, "A PRE Block must contain at least one ward");

  const t = now();
  await db.transaction(async () => {
    if (opts.name !== undefined) {
      const clash = await db.prepare(
        "SELECT id FROM pre_blocks WHERE LOWER(name)=LOWER(?) AND id<>?"
      ).get(opts.name.trim(), opts.blockId);
      if (clash) throw new HttpError(409, `PRE Block "${opts.name}" already exists`);
      await db.prepare("UPDATE pre_blocks SET name=?, updated_at=? WHERE id=?")
        .run(opts.name.trim(), t, opts.blockId);
    }
    if (opts.description !== undefined)
      await db.prepare("UPDATE pre_blocks SET description=?, updated_at=? WHERE id=?")
        .run(opts.description?.trim() || null, t, opts.blockId);

    if (opts.wardIds !== undefined) {
      await db.prepare("DELETE FROM pre_block_wards WHERE pre_block_id=?").run(opts.blockId);
      for (const wardId of opts.wardIds) {
        const ward = await db.prepare("SELECT id, name, operational, total_beds FROM wards WHERE id=?")
          .get<{ id: number; name: string; operational: boolean; total_beds: number }>(wardId);
        if (!ward) throw new HttpError(404, `Ward ${wardId} not found`);
        if (!ward.operational)
          throw new HttpError(400, `Ward "${ward.name}" is non-operational. Reactivate it before adding it to a PRE block.`);
        if (ward.total_beds === 0)
          throw new HttpError(400, `Ward "${ward.name}" has no beds. Add beds to this ward before assigning it to a PRE block.`);
        await db.prepare(
          "INSERT INTO pre_block_wards (pre_block_id, ward_id, created_at) VALUES (?,?,?)"
        ).run(opts.blockId, wardId, t);
      }
      await db.prepare("UPDATE pre_blocks SET updated_at=? WHERE id=?").run(t, opts.blockId);
    }
  });

  await audit(opts.managerId, "pre_block_edit", block.name, {});
  return { ok: true };
}

export async function setPreBlockStatus(
  blockId: number, status: "active" | "inactive", managerId: number
) {
  const block = await db.prepare("SELECT name FROM pre_blocks WHERE id=?")
    .get<{ name: string }>(blockId);
  if (!block) throw new HttpError(404, "PRE Block not found");
  await db.prepare("UPDATE pre_blocks SET status=?, updated_at=? WHERE id=?")
    .run(status, now(), blockId);
  await audit(managerId, `pre_block_${status}`, block.name, {});
  return { ok: true };
}

export async function deletePreBlock(blockId: number, managerId: number) {
  const block = await db.prepare("SELECT name FROM pre_blocks WHERE id=?")
    .get<{ name: string }>(blockId);
  if (!block) throw new HttpError(404, "PRE Block not found");
  await db.prepare("DELETE FROM pre_blocks WHERE id=?").run(blockId);
  await audit(managerId, "pre_block_delete", block.name, {});
  return { ok: true };
}

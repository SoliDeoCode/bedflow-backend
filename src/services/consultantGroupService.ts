import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

export interface ConsultantGroup { id: number; name: string; active: boolean; }
export interface ConsultantGroupWithMembers extends ConsultantGroup {
  doctors: { id: number; name: string }[];
  departments: { id: number; name: string }[];
}

export async function listGroups(activeOnly = true): Promise<ConsultantGroup[]> {
  const sql = activeOnly
    ? "SELECT id, name, active FROM consultant_groups WHERE active=true ORDER BY name"
    : "SELECT id, name, active FROM consultant_groups ORDER BY name";
  return db.prepare(sql).all<ConsultantGroup>();
}

/** Every group with its member doctors and departments — powers the admin
 *  management page and the admission-time combined picker. */
export async function listGroupsWithDetails(activeOnly = false): Promise<ConsultantGroupWithMembers[]> {
  const groups = await listGroups(activeOnly);
  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => g.id);

  const memberRows = await db.prepare(
    `SELECT m.group_id, dm.id, dm.name FROM consultant_group_members m
     JOIN doctors_master dm ON dm.id = m.doctor_id
     WHERE m.group_id = ANY(?) ORDER BY dm.name`
  ).all<{ group_id: number; id: number; name: string }>(groupIds);
  const deptRows = await db.prepare(
    `SELECT gd.group_id, d.id, d.name FROM consultant_group_departments gd
     JOIN departments d ON d.id = gd.department_id
     WHERE gd.group_id = ANY(?) ORDER BY d.name`
  ).all<{ group_id: number; id: number; name: string }>(groupIds);

  const doctorsByGroup = new Map<number, { id: number; name: string }[]>();
  for (const r of memberRows) {
    const list = doctorsByGroup.get(r.group_id) ?? [];
    list.push({ id: r.id, name: r.name });
    doctorsByGroup.set(r.group_id, list);
  }
  const deptsByGroup = new Map<number, { id: number; name: string }[]>();
  for (const r of deptRows) {
    const list = deptsByGroup.get(r.group_id) ?? [];
    list.push({ id: r.id, name: r.name });
    deptsByGroup.set(r.group_id, list);
  }
  return groups.map((g) => ({
    ...g,
    doctors: doctorsByGroup.get(g.id) ?? [],
    departments: deptsByGroup.get(g.id) ?? [],
  }));
}

export async function createGroup(opts: {
  name: string; doctorIds: number[]; departmentIds: number[]; userId: number;
}): Promise<ConsultantGroup> {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Group name is required");
  // A group only exists to represent joint ownership — a single-member "group"
  // is meaningless and should just be the individual consultant instead.
  if (opts.doctorIds.length < 2) throw new HttpError(400, "A Consultant Group needs at least 2 consultants");
  if (opts.departmentIds.length === 0) throw new HttpError(400, "At least one department is required");

  const now = Date.now();
  const row = await db.transaction(async () => {
    const g = await db.prepare(
      "INSERT INTO consultant_groups (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id, name, active"
    ).get<ConsultantGroup>(name, now, now);
    for (const doctorId of opts.doctorIds) {
      await db.prepare(
        "INSERT INTO consultant_group_members (group_id, doctor_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      ).run(g!.id, doctorId);
    }
    for (const deptId of opts.departmentIds) {
      await db.prepare(
        "INSERT INTO consultant_group_departments (group_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      ).run(g!.id, deptId);
    }
    return g!;
  });
  await audit(opts.userId, "consultant_group_create", String(row.id), { name, doctorIds: opts.doctorIds, departmentIds: opts.departmentIds });
  return row;
}

export async function updateGroup(opts: {
  id: number; name?: string; active?: boolean; doctorIds?: number[]; departmentIds?: number[]; userId: number;
}): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name FROM consultant_groups WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Consultant Group not found");

  const now = Date.now();
  if (opts.name !== undefined) {
    const name = opts.name.trim();
    if (!name) throw new HttpError(400, "Name cannot be empty");
    const clash = await db.prepare("SELECT 1 FROM consultant_groups WHERE LOWER(name)=LOWER(?) AND id!=?").get(name, opts.id);
    if (clash) throw new HttpError(409, `Consultant Group "${name}" already exists`);
    await db.prepare("UPDATE consultant_groups SET name=?, updated_at=? WHERE id=?").run(name, now, opts.id);
  }
  if (opts.active !== undefined) {
    await db.prepare("UPDATE consultant_groups SET active=?, updated_at=? WHERE id=?").run(opts.active, now, opts.id);
  }
  if (opts.doctorIds !== undefined) {
    if (opts.doctorIds.length < 2) throw new HttpError(400, "A Consultant Group needs at least 2 consultants");
    await db.transaction(async () => {
      await db.prepare("DELETE FROM consultant_group_members WHERE group_id=?").run(opts.id);
      for (const doctorId of opts.doctorIds!) {
        await db.prepare(
          "INSERT INTO consultant_group_members (group_id, doctor_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        ).run(opts.id, doctorId);
      }
    });
  }
  if (opts.departmentIds !== undefined) {
    if (opts.departmentIds.length === 0) throw new HttpError(400, "At least one department is required");
    await db.transaction(async () => {
      await db.prepare("DELETE FROM consultant_group_departments WHERE group_id=?").run(opts.id);
      for (const deptId of opts.departmentIds!) {
        await db.prepare(
          "INSERT INTO consultant_group_departments (group_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        ).run(opts.id, deptId);
      }
    });
  }
  await audit(opts.userId, "consultant_group_update", String(opts.id), {
    name: opts.name, active: opts.active, doctorIds: opts.doctorIds, departmentIds: opts.departmentIds,
  });
  return { ok: true };
}

export async function deleteGroup(opts: { id: number; userId: number }): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name FROM consultant_groups WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Consultant Group not found");

  const inUse = await db.prepare("SELECT 1 FROM patient_admissions WHERE consultant_group_id=? LIMIT 1").get(opts.id);
  if (inUse) throw new HttpError(409, `Cannot delete "${row.name}" — it has been used in one or more patient admissions. Deactivate it instead.`);

  await db.transaction(async () => {
    await db.prepare("DELETE FROM consultant_group_members WHERE group_id=?").run(opts.id);
    await db.prepare("DELETE FROM consultant_group_departments WHERE group_id=?").run(opts.id);
    await db.prepare("DELETE FROM consultant_groups WHERE id=?").run(opts.id);
  });
  await audit(opts.userId, "consultant_group_delete", String(opts.id), { name: row.name });
  return { ok: true };
}

/** The single source of truth for "does this consultant (by doctors_master id)
 *  own this admission" — used by every access check across discharge.ts and
 *  consultant.ts. Ownership is a plain OR: either they're the individual
 *  doctor on record, or they're a member of the group on record. */
export async function ownsAdmission(doctorMasterId: number, admissionId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM patient_admissions pa
     WHERE pa.id = ?
       AND ((pa.owner_type='DOCTOR' AND pa.doctor_id = ?)
         OR (pa.owner_type='GROUP' AND EXISTS (
               SELECT 1 FROM consultant_group_members m
               WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = ?)))`
  ).get(admissionId, doctorMasterId, doctorMasterId);
  return !!row;
}

export async function ownsBed(doctorMasterId: number, bedId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM patient_admissions pa
     WHERE pa.bed_id = ? AND pa.status='ACTIVE'
       AND ((pa.owner_type='DOCTOR' AND pa.doctor_id = ?)
         OR (pa.owner_type='GROUP' AND EXISTS (
               SELECT 1 FROM consultant_group_members m
               WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = ?)))`
  ).get(bedId, doctorMasterId, doctorMasterId);
  return !!row;
}

/** Every group id this doctor currently belongs to — used to compute which
 *  socket rooms a CONSULTANT should join on connect. */
export async function groupIdsForDoctor(doctorMasterId: number): Promise<number[]> {
  const rows = await db.prepare(
    "SELECT group_id FROM consultant_group_members WHERE doctor_id=?"
  ).all<{ group_id: number }>(doctorMasterId);
  return rows.map((r) => r.group_id);
}

/** The one or more socket rooms that should receive a real-time event about this
 *  admission — a single room either way (the individual doctor's room, or the
 *  group's room, which every member already joined on connect — no need to
 *  enumerate members individually). Mirrors emitUpdate's opts.pre/opts.stationId
 *  pattern, just for consultant ownership instead of ward/station scoping. */
export function consultantRoomsFor(owner: {
  owner_type: "DOCTOR" | "GROUP"; doctor_id: number | null; consultant_group_id: number | null;
}): string[] {
  if (owner.owner_type === "GROUP" && owner.consultant_group_id != null) return [`group:${owner.consultant_group_id}`];
  if (owner.owner_type === "DOCTOR" && owner.doctor_id != null) return [`consultant:${owner.doctor_id}`];
  return [];
}

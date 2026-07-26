import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { guardUniqueUsername } from "./managerService.js";

export interface ConsultantUser {
  id: number;
  username: string;
  name: string;
  status: string;
  doctor_master_id: number;
  departments: { id: number; name: string }[];
}

/** Consultant logins + their doctors_master identity, created and managed together
 *  as a single unit (mirrors PRE/Nurse/Doctor user management) — replaces the old
 *  two-step "create doctor, then set login" flow. */
export async function listConsultantUsers(): Promise<ConsultantUser[]> {
  const users = await db.prepare(
    "SELECT id, username, name, status, doctor_master_id FROM users WHERE role='CONSULTANT' ORDER BY name"
  ).all<{ id: number; username: string; name: string; status: string; doctor_master_id: number }>();
  if (users.length === 0) return [];

  const doctorIds = users.map((u) => u.doctor_master_id).filter((id): id is number => id != null);
  const rows = doctorIds.length
    ? await db.prepare(
        `SELECT dd.doctor_id, d.id, d.name FROM doctor_departments dd
         JOIN departments d ON d.id = dd.department_id
         WHERE dd.doctor_id = ANY(?)`
      ).all<{ doctor_id: number; id: number; name: string }>(doctorIds)
    : [];
  const byDoctor = new Map<number, { id: number; name: string }[]>();
  for (const r of rows) {
    const list = byDoctor.get(r.doctor_id) ?? [];
    list.push({ id: r.id, name: r.name });
    byDoctor.set(r.doctor_id, list);
  }
  return users.map((u) => ({ ...u, departments: byDoctor.get(u.doctor_master_id) ?? [] }));
}

export async function createConsultantUser(opts: {
  name: string; username: string; password: string; departmentIds?: number[]; userId: number;
}): Promise<ConsultantUser> {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Display name is required.");
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username))
    throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
  await guardUniqueUsername(username);
  if (!opts.password || opts.password.length < 8)
    throw new HttpError(400, "Password must be at least 8 characters.");

  const now = Date.now();
  const departmentIds = opts.departmentIds ?? [];
  const { doctorId, userRowId } = await db.transaction(async () => {
    const doctor = await db.prepare(
      "INSERT INTO doctors_master (name, created_at) VALUES (?, ?) RETURNING id"
    ).get<{ id: number }>(name, now);
    const user = await db.prepare(
      `INSERT INTO users (username, password_hash, role, name, doctor_master_id, status, created_at, updated_at)
       VALUES (?, ?, 'CONSULTANT', ?, ?, 'active', ?, ?) RETURNING id`
    ).get<{ id: number }>(username, bcrypt.hashSync(opts.password, 10), name, doctor!.id, now, now);
    for (const deptId of departmentIds) {
      await db.prepare(
        "INSERT INTO doctor_departments (doctor_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      ).run(doctor!.id, deptId);
    }
    return { doctorId: doctor!.id, userRowId: user!.id };
  });

  await audit(opts.userId, "consultant_user_create", String(userRowId), { name, username, doctorId, departmentIds });

  const departments = departmentIds.length
    ? await db.prepare("SELECT id, name FROM departments WHERE id = ANY(?)").all<{ id: number; name: string }>(departmentIds)
    : [];
  return { id: userRowId, username, name, status: "active", doctor_master_id: doctorId, departments };
}

export async function updateConsultantUser(opts: {
  id: number; name?: string; username?: string; password?: string; active?: boolean;
  departmentIds?: number[]; userId: number;
}): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name, doctor_master_id FROM users WHERE id=? AND role='CONSULTANT'")
    .get<{ id: number; name: string; doctor_master_id: number }>(opts.id);
  if (!row) throw new HttpError(404, "Consultant user not found.");

  const now = Date.now();
  await db.transaction(async () => {
    if (opts.name !== undefined) {
      const name = opts.name.trim();
      if (!name) throw new HttpError(400, "Display name cannot be empty.");
      await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(name, now, opts.id);
      // Keep doctors_master.name in sync — it's what shows in the admission
      // picker and the consultant_name display mirror on new admissions.
      await db.prepare("UPDATE doctors_master SET name=? WHERE id=?").run(name, row.doctor_master_id);
    }
    if (opts.username !== undefined) {
      const username = opts.username.trim().toLowerCase();
      if (!/^[a-z0-9_]+$/.test(username))
        throw new HttpError(400, "Username can only contain letters, numbers, and underscores — no spaces or special characters.");
      const clash = await db.prepare("SELECT id FROM users WHERE username=? AND id!=?").get(username, opts.id);
      if (clash) throw new HttpError(409, `Username "${username}" is already in use.`);
      await db.prepare("UPDATE users SET username=?, updated_at=? WHERE id=?").run(username, now, opts.id);
    }
    if (opts.password) {
      if (opts.password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
      await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?").run(bcrypt.hashSync(opts.password, 10), now, opts.id);
    }
    if (opts.active !== undefined) {
      await db.prepare("UPDATE users SET status=?, updated_at=? WHERE id=?").run(opts.active ? "active" : "inactive", now, opts.id);
      await db.prepare("UPDATE doctors_master SET active=? WHERE id=?").run(opts.active, row.doctor_master_id);
    }
    if (opts.departmentIds !== undefined) {
      await db.prepare("DELETE FROM doctor_departments WHERE doctor_id=?").run(row.doctor_master_id);
      for (const deptId of opts.departmentIds) {
        await db.prepare(
          "INSERT INTO doctor_departments (doctor_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        ).run(row.doctor_master_id, deptId);
      }
    }
  });

  await audit(opts.userId, "consultant_user_update", String(opts.id), {
    name: opts.name, username: opts.username, active: opts.active, departmentIds: opts.departmentIds,
  });
  return { ok: true };
}

export async function deleteConsultantUser(opts: { id: number; userId: number }): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name, doctor_master_id FROM users WHERE id=? AND role='CONSULTANT'")
    .get<{ id: number; name: string; doctor_master_id: number }>(opts.id);
  if (!row) throw new HttpError(404, "Consultant user not found.");

  const inUse = await db.prepare(
    `SELECT 1 FROM patient_admissions WHERE doctor_id=?
     UNION ALL
     SELECT 1 FROM consultant_group_members WHERE doctor_id=?`
  ).get(row.doctor_master_id, row.doctor_master_id);
  if (inUse)
    throw new HttpError(409, `Cannot delete "${row.name}" — they've been used in a patient admission or belong to a Consultant Group. Deactivate them instead.`);

  await db.transaction(async () => {
    await db.prepare("DELETE FROM users WHERE id=?").run(opts.id);
    await db.prepare("DELETE FROM doctors_master WHERE id=?").run(row.doctor_master_id);
  });
  await audit(opts.userId, "consultant_user_delete", String(opts.id), { name: row.name });
  return { ok: true };
}

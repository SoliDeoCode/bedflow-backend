import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

export interface Department { id: number; name: string; active: boolean; }
export interface DoctorMaster { id: number; name: string; active: boolean; }
export interface DoctorMasterWithDepartments extends DoctorMaster {
  departments: { id: number; name: string }[];
}

export async function listDepartments(activeOnly = true): Promise<Department[]> {
  const sql = activeOnly
    ? "SELECT id, name, active FROM departments WHERE active=true ORDER BY name"
    : "SELECT id, name, active FROM departments ORDER BY name";
  return db.prepare(sql).all<Department>();
}

export async function listDoctors(departmentId?: number | null, activeOnly = true): Promise<DoctorMaster[]> {
  if (departmentId) {
    const sql = activeOnly
      ? `SELECT dm.id, dm.name, dm.active FROM doctors_master dm
         JOIN doctor_departments dd ON dd.doctor_id = dm.id
         WHERE dd.department_id = ? AND dm.active = true ORDER BY dm.name`
      : `SELECT dm.id, dm.name, dm.active FROM doctors_master dm
         JOIN doctor_departments dd ON dd.doctor_id = dm.id
         WHERE dd.department_id = ? ORDER BY dm.name`;
    return db.prepare(sql).all<DoctorMaster>(departmentId);
  }
  const sql = activeOnly
    ? "SELECT id, name, active FROM doctors_master WHERE active=true ORDER BY name"
    : "SELECT id, name, active FROM doctors_master ORDER BY name";
  return db.prepare(sql).all<DoctorMaster>();
}

export async function createDepartment(name: string): Promise<Department> {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, "Department name is required");
  const row = await db.prepare(
    "INSERT INTO departments (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET active=true RETURNING id, name, active"
  ).get<Department>(trimmed);
  return row!;
}

export async function createDoctor(name: string, departmentIds: number[]): Promise<DoctorMaster> {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, "Doctor name is required");
  if (departmentIds.length === 0) throw new HttpError(400, "At least one department is required");

  const now = Date.now();
  const row = await db.prepare(
    "INSERT INTO doctors_master (name, created_at) VALUES (?, ?) RETURNING id, name, active"
  ).get<DoctorMaster>(trimmed, now);
  const doctorId = row!.id;

  for (const deptId of departmentIds) {
    await db.prepare(
      "INSERT INTO doctor_departments (doctor_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
    ).run(doctorId, deptId);
  }
  return row!;
}

export async function addDoctorToDepartment(doctorId: number, departmentId: number): Promise<void> {
  await db.prepare(
    "INSERT INTO doctor_departments (doctor_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
  ).run(doctorId, departmentId);
}

export async function removeDoctorFromDepartment(doctorId: number, departmentId: number): Promise<void> {
  await db.prepare(
    "DELETE FROM doctor_departments WHERE doctor_id = ? AND department_id = ?"
  ).run(doctorId, departmentId);
}

/** Every doctor with the departments they belong to — powers the admin management page. */
export async function listDoctorsWithDepartments(activeOnly = false): Promise<DoctorMasterWithDepartments[]> {
  const doctors = await listDoctors(undefined, activeOnly);
  if (doctors.length === 0) return [];
  const rows = await db.prepare(
    `SELECT dd.doctor_id, d.id, d.name FROM doctor_departments dd
     JOIN departments d ON d.id = dd.department_id
     WHERE dd.doctor_id = ANY(?)`
  ).all<{ doctor_id: number; id: number; name: string }>(doctors.map((d) => d.id));
  const byDoctor = new Map<number, { id: number; name: string }[]>();
  for (const r of rows) {
    const list = byDoctor.get(r.doctor_id) ?? [];
    list.push({ id: r.id, name: r.name });
    byDoctor.set(r.doctor_id, list);
  }
  return doctors.map((d) => ({ ...d, departments: byDoctor.get(d.id) ?? [] }));
}

export async function updateDepartment(opts: {
  id: number; name?: string; active?: boolean; userId: number;
}): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name FROM departments WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Department not found");

  if (opts.name !== undefined) {
    const name = opts.name.trim();
    if (!name) throw new HttpError(400, "Name cannot be empty");
    const clash = await db.prepare("SELECT 1 FROM departments WHERE LOWER(name)=LOWER(?) AND id!=?").get(name, opts.id);
    if (clash) throw new HttpError(409, `Department "${name}" already exists`);
    await db.prepare("UPDATE departments SET name=? WHERE id=?").run(name, opts.id);
  }
  if (opts.active !== undefined) {
    await db.prepare("UPDATE departments SET active=? WHERE id=?").run(opts.active, opts.id);
  }
  await audit(opts.userId, "department_update", String(opts.id), { name: opts.name, active: opts.active });
  return { ok: true };
}

export async function deleteDepartment(opts: { id: number; userId: number }): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name FROM departments WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Department not found");

  const inUse = await db.prepare("SELECT 1 FROM patient_admissions WHERE department_id=? LIMIT 1").get(opts.id);
  if (inUse) throw new HttpError(409, `Cannot delete "${row.name}" — it has been used in one or more patient admissions. Deactivate it instead.`);

  await db.transaction(async () => {
    await db.prepare("DELETE FROM doctor_departments WHERE department_id=?").run(opts.id);
    await db.prepare("DELETE FROM departments WHERE id=?").run(opts.id);
  });
  await audit(opts.userId, "department_delete", String(opts.id), { name: row.name });
  return { ok: true };
}

export async function updateDoctorMaster(opts: {
  id: number; name?: string; active?: boolean; departmentIds?: number[]; userId: number;
}): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name FROM doctors_master WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Doctor not found");

  if (opts.name !== undefined) {
    const name = opts.name.trim();
    if (!name) throw new HttpError(400, "Name cannot be empty");
    await db.prepare("UPDATE doctors_master SET name=? WHERE id=?").run(name, opts.id);
  }
  if (opts.active !== undefined) {
    await db.prepare("UPDATE doctors_master SET active=? WHERE id=?").run(opts.active, opts.id);
  }
  if (opts.departmentIds !== undefined) {
    if (opts.departmentIds.length === 0) throw new HttpError(400, "At least one department is required");
    await db.transaction(async () => {
      await db.prepare("DELETE FROM doctor_departments WHERE doctor_id=?").run(opts.id);
      for (const deptId of opts.departmentIds!) {
        await db.prepare(
          "INSERT INTO doctor_departments (doctor_id, department_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        ).run(opts.id, deptId);
      }
    });
  }
  await audit(opts.userId, "doctor_master_update", String(opts.id), { name: opts.name, active: opts.active, departmentIds: opts.departmentIds });
  return { ok: true };
}

export async function deleteDoctorMaster(opts: { id: number; userId: number }): Promise<{ ok: true }> {
  const row = await db.prepare("SELECT id, name FROM doctors_master WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Doctor not found");

  const inUse = await db.prepare("SELECT 1 FROM patient_admissions WHERE doctor_id=? LIMIT 1").get(opts.id);
  if (inUse) throw new HttpError(409, `Cannot delete "${row.name}" — they have been used in one or more patient admissions. Deactivate them instead.`);

  await db.transaction(async () => {
    await db.prepare("DELETE FROM doctor_departments WHERE doctor_id=?").run(opts.id);
    await db.prepare("DELETE FROM doctors_master WHERE id=?").run(opts.id);
  });
  await audit(opts.userId, "doctor_master_delete", String(opts.id), { name: row.name });
  return { ok: true };
}

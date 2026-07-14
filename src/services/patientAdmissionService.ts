import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

export interface PatientAdmission {
  id: number;
  bed_id: number;
  ward_id: number;
  /** Null only for admissions backfilled for beds that were already Occupied
   *  before the discharge module existed — every new admission has one. */
  ip_last6: string | null;
  /** Manual free-text entry captured at admission — same "V1 manual, HIS later" pattern as ip_last6. */
  consultant_name: string | null;
  department_name: string | null;
  /** "IP" | "DAYCARE" — null only for admissions predating this field. */
  admission_type: string | null;
  status: "ACTIVE" | "DISCHARGED";
  admitted_at: number;
  discharged_at: number | null;
  created_by: number | null;
  updated_at: number;
}

const IP_LAST6_RE = /^\d{6}$/;
const ADMISSION_TYPES = ["IP", "DAYCARE", "OPD"];

export function validateIpLast6(ipLast6: string | undefined | null): string {
  const trimmed = (ipLast6 ?? "").toString().trim();
  if (!trimmed) throw new HttpError(400, "Last 6 digits of IP Number are required.");
  if (!IP_LAST6_RE.test(trimmed))
    throw new HttpError(400, "IP Number must be exactly 6 digits.");
  return trimmed;
}

export function validateAdmissionType(admissionType: string | undefined | null): string {
  const value = (admissionType ?? "").toString().trim().toUpperCase();
  if (!ADMISSION_TYPES.includes(value)) throw new HttpError(400, "Admission type must be IP, Daycare, or OPD.");
  return value;
}

export async function getActiveAdmissionByBed(bedId: number): Promise<PatientAdmission | undefined> {
  return db.prepare(
    "SELECT * FROM patient_admissions WHERE bed_id=? AND status='ACTIVE'"
  ).get<PatientAdmission>(bedId);
}

export async function getAdmissionById(admissionId: number): Promise<PatientAdmission | undefined> {
  return db.prepare("SELECT * FROM patient_admissions WHERE id=?").get<PatientAdmission>(admissionId);
}

/** Creates a fresh admission for a bed that just went Vacant → Occupied. Called from the
 *  bedDetailService post-commit hook — never call this directly from a route. */
export async function createAdmission(opts: {
  bedId: number; wardId: number; ipLast6: string; admissionType: string; userId: number;
  consultantName?: string | null; departmentName?: string | null;
  doctorId?: number | null; departmentId?: number | null;
}): Promise<PatientAdmission> {
  const ipLast6 = validateIpLast6(opts.ipLast6);
  const admissionType = validateAdmissionType(opts.admissionType);
  const consultantName = opts.consultantName?.toString().trim() || null;
  const departmentName = opts.departmentName?.toString().trim() || null;
  const doctorId = opts.doctorId ?? null;
  const departmentId = opts.departmentId ?? null;
  if (!departmentId) throw new HttpError(400, "Department is required.");
  if (!doctorId) throw new HttpError(400, "Consultant is required.");
  const existing = await getActiveAdmissionByBed(opts.bedId);
  if (existing) throw new HttpError(409, "This bed already has an active patient admission.");

  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO patient_admissions (bed_id, ward_id, ip_last6, admission_type, consultant_name, department_name, doctor_id, department_id, status, admitted_at, created_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'ACTIVE',?,?,?) RETURNING id`
  ).run(opts.bedId, opts.wardId, ipLast6, admissionType, consultantName, departmentName, doctorId, departmentId, now, opts.userId, now);
  const admission = await getAdmissionById(Number(row.lastInsertRowid));

  await audit(opts.userId, "admission_create", String(opts.bedId), { ipLast6, admissionType, wardId: opts.wardId, consultantName, departmentName, doctorId, departmentId });
  return admission!;
}

/** Closes an admission — either a normal discharge completion or a manual/unexpected vacate. */
export async function closeAdmission(admissionId: number, userId: number | null): Promise<void> {
  const now = Date.now();
  await db.prepare(
    "UPDATE patient_admissions SET status='DISCHARGED', discharged_at=?, updated_at=? WHERE id=? AND status='ACTIVE'"
  ).run(now, now, admissionId);
  await audit(userId, "admission_close", String(admissionId), {});
}

/** Moves an admission (and thus its discharge workflow) to a new bed/ward — used by bed transfer. */
export async function moveAdmission(opts: {
  admissionId: number; newBedId: number; newWardId: number; userId: number;
}): Promise<void> {
  const now = Date.now();
  await db.prepare(
    "UPDATE patient_admissions SET bed_id=?, ward_id=?, updated_at=? WHERE id=?"
  ).run(opts.newBedId, opts.newWardId, now, opts.admissionId);
  await audit(opts.userId, "admission_move", String(opts.admissionId), {
    newBedId: opts.newBedId, newWardId: opts.newWardId,
  });
}

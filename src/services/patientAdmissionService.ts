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
  doctor_id: number | null;
  department_id: number | null;
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

  const dupIp = await db.prepare(
    "SELECT bed_id FROM patient_admissions WHERE ip_last6=? AND status='ACTIVE' LIMIT 1"
  ).get<{ bed_id: number }>(ipLast6);
  if (dupIp) {
    const dupBed = await db.prepare("SELECT bed_name FROM bed_details WHERE id=?").get<{ bed_name: string }>(dupIp.bed_id);
    throw new HttpError(409, `IP ${ipLast6} is already admitted on bed ${dupBed?.bed_name ?? dupIp.bed_id}. Discharge or transfer the existing admission first.`);
  }

  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO patient_admissions (bed_id, ward_id, ip_last6, admission_type, consultant_name, department_name, doctor_id, department_id, status, admitted_at, created_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'ACTIVE',?,?,?) RETURNING id`
  ).run(opts.bedId, opts.wardId, ipLast6, admissionType, consultantName, departmentName, doctorId, departmentId, now, opts.userId, now);
  const admission = await getAdmissionById(Number(row.lastInsertRowid));

  await audit(opts.userId, "admission_create", String(opts.bedId), { ipLast6, admissionType, wardId: opts.wardId, consultantName, departmentName, doctorId, departmentId });
  return admission!;
}

/** Corrects details captured at admission time (typo in IP number, wrong consultant
 *  picked, etc.) on the bed's currently active admission. Unlike createAdmission this
 *  never changes bed_details.physical_status — the bed stays Occupied throughout, only
 *  the patient_admissions row is touched. Every field is optional/independent so a
 *  caller can send only what changed; omitted fields keep their current value. */
export async function updateActiveAdmission(opts: {
  bedId: number; userId: number;
  ipLast6?: string; admissionType?: string;
  consultantName?: string | null; departmentName?: string | null;
  doctorId?: number | null; departmentId?: number | null;
  payerType?: string | null;
}): Promise<PatientAdmission> {
  const admission = await getActiveAdmissionByBed(opts.bedId);
  if (!admission) throw new HttpError(404, "No active admission on this bed.");

  const ipLast6 = opts.ipLast6 !== undefined ? validateIpLast6(opts.ipLast6) : admission.ip_last6;
  const admissionType = opts.admissionType !== undefined ? validateAdmissionType(opts.admissionType) : admission.admission_type;
  const doctorId = opts.doctorId !== undefined ? opts.doctorId : admission.doctor_id;
  const departmentId = opts.departmentId !== undefined ? opts.departmentId : admission.department_id;
  const consultantName = opts.consultantName !== undefined ? (opts.consultantName?.toString().trim() || null) : admission.consultant_name;
  const departmentName = opts.departmentName !== undefined ? (opts.departmentName?.toString().trim() || null) : admission.department_name;
  if (!departmentId) throw new HttpError(400, "Department is required.");
  if (!doctorId) throw new HttpError(400, "Consultant is required.");

  const now = Date.now();
  await db.prepare(
    `UPDATE patient_admissions
     SET ip_last6=?, admission_type=?, consultant_name=?, department_name=?, doctor_id=?, department_id=?, updated_at=?
     WHERE id=? AND status='ACTIVE'`
  ).run(ipLast6, admissionType, consultantName, departmentName, doctorId, departmentId, now, admission.id);

  if (opts.payerType !== undefined) {
    await db.prepare(
      "UPDATE bed_details SET payer_type=?, updated_at=? WHERE id=?"
    ).run(opts.payerType, now, opts.bedId);
  }

  await audit(opts.userId, "admission_update", String(opts.bedId), {
    old: {
      ipLast6: admission.ip_last6, admissionType: admission.admission_type,
      consultantName: admission.consultant_name, departmentName: admission.department_name,
      doctorId: admission.doctor_id, departmentId: admission.department_id,
      payerType: opts.payerType !== undefined ? undefined : "(unchanged)",
    },
    new: { ipLast6, admissionType, consultantName, departmentName, doctorId, departmentId,
           ...(opts.payerType !== undefined ? { payerType: opts.payerType } : {}) },
  });

  return (await getAdmissionById(admission.id))!;
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

import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { updateStep, type StepKey } from "./dischargeService.js";

export interface ReopenRequest {
  id: number;
  tracking_id: number;
  admission_id: number;
  step_key: string;
  requested_by: number;
  reason: string;
  status: string;
  reviewed_by: number | null;
  review_note: string | null;
  created_at: number;
  reviewed_at: number | null;
  ward_name: string | null;
  bed_name: string | null;
  requester_name?: string;
}

const PHARMACY_STEPS: StepKey[] = ["DRUG_RETURN", "PHARMACY_CLEARANCE"];
const FC_STEPS: StepKey[] = ["BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT"];
const REOPENABLE_STEPS: StepKey[] = [...PHARMACY_STEPS, ...FC_STEPS];

export function isPharmacyStep(step: StepKey): boolean { return PHARMACY_STEPS.includes(step); }
export function isFCStep(step: StepKey): boolean { return FC_STEPS.includes(step); }

export async function createReopenRequest(opts: {
  admissionId: number; stepKey: StepKey; reason: string; userId: number;
}): Promise<ReopenRequest> {
  if (!REOPENABLE_STEPS.includes(opts.stepKey))
    throw new HttpError(400, "Reopen requests are not supported for this step");

  const tracking = await db.prepare(
    `SELECT dt.id, dt.${opts.stepKey.toLowerCase()}_status as step_status,
            w.name as ward_name, bd.bed_name
     FROM discharge_tracking dt
     JOIN patient_admissions pa ON pa.id = dt.admission_id
     JOIN bed_details bd ON bd.id = pa.bed_id
     JOIN wards w ON w.id = bd.ward_id
     WHERE dt.admission_id = ?`
  ).get<{ id: number; step_status: string; ward_name: string; bed_name: string }>(opts.admissionId);

  if (!tracking) throw new HttpError(404, "No discharge found for this admission");
  if (tracking.step_status !== "COMPLETED")
    throw new HttpError(409, "Step is not completed — nothing to reopen");

  const existing = await db.prepare(
    `SELECT id FROM reopen_requests WHERE tracking_id=? AND step_key=? AND status='PENDING'`
  ).get<{ id: number }>(tracking.id, opts.stepKey);
  if (existing) throw new HttpError(409, "A reopen request for this step is already pending");

  const now = Date.now();
  const r = await db.prepare(
    `INSERT INTO reopen_requests (tracking_id, admission_id, step_key, requested_by, reason, status, created_at, ward_name, bed_name)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?) RETURNING id`
  ).run(tracking.id, opts.admissionId, opts.stepKey, opts.userId, opts.reason, now, tracking.ward_name, tracking.bed_name);

  await audit(opts.userId, "reopen_request_create", String(opts.admissionId), {
    step: opts.stepKey, reason: opts.reason,
  });

  return (await db.prepare("SELECT * FROM reopen_requests WHERE id=?")
    .get<ReopenRequest>(Number(r.lastInsertRowid)))!;
}

export async function listPendingRequests(stepFilter?: StepKey[]): Promise<ReopenRequest[]> {
  if (stepFilter && stepFilter.length > 0) {
    const placeholders = stepFilter.map(() => "?").join(",");
    return db.prepare(
      `SELECT rr.*, u.name as requester_name
       FROM reopen_requests rr
       JOIN users u ON u.id = rr.requested_by
       WHERE rr.status = 'PENDING' AND rr.step_key IN (${placeholders})
       ORDER BY rr.created_at DESC`
    ).all<ReopenRequest>(...stepFilter);
  }
  return db.prepare(
    `SELECT rr.*, u.name as requester_name
     FROM reopen_requests rr
     JOIN users u ON u.id = rr.requested_by
     WHERE rr.status = 'PENDING'
     ORDER BY rr.created_at DESC`
  ).all<ReopenRequest>();
}

export async function listMyRequests(userId: number, stepFilter?: StepKey[]): Promise<ReopenRequest[]> {
  if (stepFilter && stepFilter.length > 0) {
    const placeholders = stepFilter.map(() => "?").join(",");
    return db.prepare(
      `SELECT * FROM reopen_requests WHERE requested_by = ? AND step_key IN (${placeholders}) ORDER BY created_at DESC LIMIT 50`
    ).all<ReopenRequest>(userId, ...stepFilter);
  }
  return db.prepare(
    `SELECT * FROM reopen_requests WHERE requested_by = ? ORDER BY created_at DESC LIMIT 50`
  ).all<ReopenRequest>(userId);
}

export async function reviewRequest(opts: {
  requestId: number; action: "APPROVED" | "DENIED"; reviewNote?: string | null;
  userId: number; role: string;
}): Promise<ReopenRequest> {
  const req = await db.prepare("SELECT * FROM reopen_requests WHERE id=?")
    .get<ReopenRequest>(opts.requestId);
  if (!req) throw new HttpError(404, "Reopen request not found");
  if (req.status !== "PENDING") throw new HttpError(409, `Request already ${req.status}`);

  const now = Date.now();
  await db.prepare(
    `UPDATE reopen_requests SET status=?, reviewed_by=?, review_note=?, reviewed_at=? WHERE id=?`
  ).run(opts.action, opts.userId, opts.reviewNote ?? null, now, opts.requestId);

  if (opts.action === "APPROVED") {
    await updateStep({
      admissionId: req.admission_id,
      step: req.step_key as StepKey,
      status: "PENDING",
      userId: opts.userId,
      role: opts.role as any,
      reason: `Reopened via request #${req.id}: ${req.reason}`,
    });
  }

  await audit(opts.userId, `reopen_request_${opts.action.toLowerCase()}`, String(req.admission_id), {
    requestId: req.id, step: req.step_key,
  });

  return (await db.prepare("SELECT * FROM reopen_requests WHERE id=?")
    .get<ReopenRequest>(opts.requestId))!;
}

export async function pendingCount(stepFilter?: StepKey[]): Promise<number> {
  if (stepFilter && stepFilter.length > 0) {
    const placeholders = stepFilter.map(() => "?").join(",");
    const r = await db.prepare(
      `SELECT COUNT(*) as cnt FROM reopen_requests WHERE status='PENDING' AND step_key IN (${placeholders})`
    ).get<{ cnt: number }>(...stepFilter);
    return r?.cnt ?? 0;
  }
  const r = await db.prepare("SELECT COUNT(*) as cnt FROM reopen_requests WHERE status='PENDING'")
    .get<{ cnt: number }>();
  return r?.cnt ?? 0;
}
